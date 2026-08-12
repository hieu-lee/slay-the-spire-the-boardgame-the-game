import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cardCost, cardDef, faceOf } from '../game/cards.ts'
import type { CardDef, Effect } from '../game/cards.ts'
import {
  activatePower,
  activatePotion,
  beginEndPlayerTurn,
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  cardPlayConditionMet,
  chosenEvokeOrbs,
  chooseEndTurnTarget,
  defaultEndTurnOrder,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  endPlayerTurn,
  enemyTurn,
  enemyLabel,
  effectIsActive,
  evokeTargetProgress,
  lightningRowFromTarget,
  lightningRowTarget,
  lightningTargetsRows,
  nextEvokeChoice,
  overflowShivCount,
  orderStartTurnScries,
  pendingTriggerAbility,
  playCard,
  playCardCopy,
  playCost,
  previewCardChoice,
  previewCardCopyChoice,
  powerAbilityKey,
  powerAbilityUsed,
  resolveStartPlayerTurn,
  resolveStartTurnScry,
  resolvePendingTrigger,
  spendMiracle,
  spendShiv,
  startTurnAbilities,
  startTurnScryAbilities,
  startTurnScryPreview,
  startPlayerTurnWithChoices,
  validEndTurnOrder,
} from '../game/combat.ts'
import type {
  CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, PotionContext, PowerContext,
  StartTurnAbility, StartTurnChoice, StartTurnScryAbility, StartTurnScryPreview,
} from '../game/combat.ts'
import { potionDef } from '../game/relics.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import { CAPS } from '../game/types.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { Icon, IconValue, dieIcon } from './Icon.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { PowerRow } from './PowerRow.tsx'
import { TokenRow } from './TokenRow.tsx'
import { healthBand, strikeClass } from './board-signals.ts'

type CombatScreenProps = {
  state: CombatState
  /** The seat this client controls. Everyone sees the same board. */
  viewerId: string
  onChange?: (next: CombatState) => void
  onAction?: (action: Record<string, unknown>) => void | Promise<ActionOutcome | void>
  drawCount?: number
  decidedPlayerIds?: string[]
  savedDiscardOrder?: string[]
  /** Private cards revealed by a staged online play, visible only to this seat. */
  cardPreview?: {
    cardUid: string
    copy?: boolean
    kind: 'discard' | 'scry' | 'topdeck' | 'search'
    cards: CardInstance[]
    spendMiracle: boolean
    enemyUid: string | null
  }
  partyEndTurnAbilities?: EndTurnAbility[]
  savedEndTurnOrder?: string[]
  endTurnCoordinatorId?: string | null
  partyStartTurnAbilities?: StartTurnAbility[]
  partyStartTurnScryAbilities?: StartTurnScryAbility[]
  startTurnCoordinatorId?: string | null
  partyStartTurnScry?: Omit<StartTurnScryPreview, 'cards'> & { cards: CardInstance[] | null }
  /** Room snapshot version; omitted for the local table. */
  authoritativeVersion?: number
  /** Successful REST refresh count; omitted for the local table. */
  authoritativeRefresh?: number
}

type UnknownPotionAction = { refreshAttempt: number; potionId: string; countBefore: number }
type UnknownPowerAction = { refreshAttempt: number; powerUid: string }
type UnknownCardAction = { refreshAttempt: number; cardUid: string; copy: boolean; copiesBefore?: number }
type PendingStartChoice =
  | { kind: 'enemy'; ability: StartTurnAbility }
  | { kind: 'shiv'; ability: StartTurnAbility; index: number }
  | { kind: 'evokeTarget'; ability: StartTurnAbility; index: number }
  | { kind: 'evoke'; ability: StartTurnAbility }

/** What a card still needs before it can be played. */
type Pending = {
  card: CardInstance
  /** False for a physical original resolving after its virtual copy. */
  cardInHand: boolean
  /** Energy chosen for an X-cost card; null until the player decides. */
  energySpent: number | null
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
    kind: 'discard' | 'discardAny' | 'exhaust' | 'exhaustAny' | 'scry' | 'topdeck' | 'recover' | 'recoverExhaust' | 'search'
    amount: number
    minimum?: number
  } | null
  /** Private post-draw/Scry cards; null means choose from the visible hand. */
  choiceCards: CardInstance[] | null
  choiceConfirmed: boolean
  picked: string[]
}

/** A round divider in the log, styled apart from the events inside the round. */
const TURN_MARKER = /^Turn \d+ begins/

/**
 * The current round, newest first, plus the divider that opened it.
 *
 * Everything since the last divider — never a fixed tail. A tail silently drops
 * lines, and if the box happens not to overflow there is nothing on screen to
 * say so.
 */
function roundLog(log: readonly string[]): string[] {
  let start = -1
  for (let i = log.length - 1; i >= 0; i--) {
    if (TURN_MARKER.test(log[i]!)) {
      start = i
      break
    }
  }
  const round = start >= 0 ? log.slice(start) : log.slice(-12)
  return [...round].reverse()
}

/** The engine's phase names are for the engine; players get words. */
const PHASE_LABEL: Record<CombatState['phase'], string> = {
  player: 'Your turn',
  copy: 'Resolve original card',
  start: 'Start of turn',
  discard: 'Order discards',
  enemy: 'Enemies act',
  roundEnd: 'Round over',
  won: 'Victory',
  lost: 'Defeat',
}

function requirementsOf(
  def: CardDef,
  allies: number,
  viewer: Player,
  state: CombatState,
  energySpent?: number,
  cardInHand = true,
): Omit<Pending, 'card' | 'cardInHand' | 'energySpent' | 'picked' | 'enemyUid' | 'playerId' | 'switchPlayerId' | 'switchChoiceDone' | 'enemyUids' | 'playerIds' | 'shivEnemyUids' | 'evokeSlots' | 'evokeEnemyUids' | 'mode' | 'choiceCards' | 'choiceConfirmed'> {
  const onPlayEffects = def.type === 'power' && def.resolvesOnPlay !== true ? [] : def.effects
  // The same predicate the engine uses to decide whether to REFUSE the play.
  // Two copies of this list drifted apart once already: the UI would prompt for
  // an enemy and the engine would then throw the choice away. The viewer goes
  // in because a counted attack with nothing to count reaches nobody, and
  // asking where to point it is asking a question with no consequence.
  const cardTarget = cardNeedsEnemy(def, viewer, false, energySpent)
  const shivsGained = cardShivsOnPlay(def)
  const overflowShivs = overflowShivCount(state, shivsGained)
  const spentShivs = cardShivChoiceCount(def, viewer)
  const enemyChoices = onPlayEffects.length > 0 ? cardEnemyChoiceCount(def) : 0
  const playerChoices = onPlayEffects.length > 0 ? cardPlayerChoiceCount(def) : 0
  const needsEnemy = cardTarget || spentShivs > 0 || overflowShivs > 0 || enemyChoices > 0
  // With one player on the board there is nobody to choose between, so asking
  // "who gets it" is a prompt with a single possible answer.
  const needsAlly = def.supportTarget === 'anyPlayer' && allies > 1
  const needsSwitch = onPlayEffects.some((effect) => effect.kind === 'switchRows') && allies > 1
  const discard = onPlayEffects.find((effect) => effect.kind === 'discard')
  const discardAny = onPlayEffects.some((effect) => effect.kind === 'discardAny')
  const exhaust = onPlayEffects.find((effect) => effect.kind === 'exhaustFromHand')
  const exhaustAny = onPlayEffects.find((effect) => effect.kind === 'exhaustAny')
  const topdeck = onPlayEffects.find((effect) => effect.kind === 'topdeck')
  const recover = onPlayEffects.find((effect) => effect.kind === 'recoverDiscard')
  const recoverExhaust = onPlayEffects.find((effect) => effect.kind === 'recoverExhaust')
  const search = onPlayEffects.find((effect) => effect.kind === 'searchDraw')
  const scried = onPlayEffects.find((effect): effect is Extract<Effect, { kind: 'scry' }> =>
    effect.kind === 'scry' && effectIsActive(effect, state, viewer))
  const choice = discard
    ? { kind: 'discard' as const, amount: discard.amount }
    : discardAny
      ? { kind: 'discardAny' as const, amount: Math.max(0, viewer.hand.length - Number(cardInHand)) }
    : exhaust
      ? { kind: 'exhaust' as const, amount: exhaust.amount }
    : exhaustAny
      ? { kind: 'exhaustAny' as const, amount: exhaustAny.amount, minimum: exhaustAny.minimum }
      : scried
        ? { kind: 'scry' as const, amount: scried.amount }
        : topdeck
          ? { kind: 'topdeck' as const, amount: topdeck.amount }
        : recover && viewer.discard.length > 0
          ? { kind: 'recover' as const, amount: recover.amount }
        : recoverExhaust && viewer.exhaust.length > 0
          ? { kind: 'recoverExhaust' as const, amount: recoverExhaust.amount }
        : search
          ? { kind: 'search' as const, amount: search.amount }
        : null
  return {
    needsEnemy,
    needsAlly,
    needsSwitch,
    overflowShivs,
    spentShivs,
    enemyChoices,
    playerChoices,
    hitsRow: def.target === 'row',
    choice,
  }
}

function pendingFor(
  card: CardInstance,
  choiceCards: CardInstance[] | null,
  state: CombatState,
  viewer: Player,
  cardInHand = true,
  copiedEnergySpent?: number,
): Pending {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const forced = state.startTurnProgress?.forcedCard?.playerId === viewer.id &&
    state.startTurnProgress.forcedCard.cardUid === card.uid
  const energySpent = copiedEnergySpent ?? (!forced && playCost(def, viewer, card) === 'X' ? null : 0)
  const requirements = requirementsOf(
    def, state.players.filter((player) => !player.dead).length, viewer, state, energySpent ?? undefined, cardInHand,
  )
  return {
    card,
    cardInHand,
    energySpent,
    ...requirements,
    enemyUid: null,
    playerId: null,
    switchPlayerId: null,
    switchChoiceDone: false,
    enemyUids: [],
    playerIds: state.players.filter((player) => !player.dead).length === 1
      ? Array(requirements.playerChoices).fill(viewer.id)
      : [],
    shivEnemyUids: [],
    evokeSlots: [],
    evokeEnemyUids: [],
    mode: null,
    choiceCards: choiceCards ?? (requirements.choice?.kind === 'recover'
      ? viewer.discard
      : requirements.choice?.kind === 'recoverExhaust' ? viewer.exhaust : null),
    choiceConfirmed: false,
    picked: [],
  }
}

function gainedShivs(effects: readonly Effect[], discarded = 0): number {
  return effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount
    : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0), 0)
}

function cardShivsOnPlay(def: CardDef, discarded = 0): number {
  return def.type === 'power' && def.trigger && def.resolvesOnPlay !== true
    ? 0
    : gainedShivs(def.effects, discarded)
}

/**
 * The name and cost of the card on top of a face-up pile.
 *
 * The end of the array is the top: piles are stored bottom-first, and the most
 * recently discarded card is the one a card like Steam Barrier reads.
 */
function topOf(pile: readonly CardInstance[], powers: readonly CardInstance[], lostHpThisCombat: boolean): string | null {
  const top = pile.at(-1)
  if (!top) return null
  const def = faceOf(cardDef(top.defId), top.upgraded)
  return `${def.unplayable ? '—' : cardCost(def, powers, lostHpThisCombat)} · ${def.name}`
}

/** Rows are the board's spatial unit: one per player, enemies sit in them. */
function rowsOf(state: CombatState): number[] {
  const rows = new Set<number>()
  for (const player of state.players) rows.add(player.row)
  for (const enemy of state.enemies) if (!enemy.isBoss) rows.add(enemy.row)
  return [...rows].sort((a, b) => b - a)
}

function revealViewerRow(board: HTMLElement | null, row: HTMLElement | null) {
  if (!board || !row) return
  const boardBox = board.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  board.scrollTop += rowBox.top - boardBox.top - (board.clientHeight - rowBox.height) / 2
}

/**
 * The seat button's accessible name.
 *
 * An `aria-label` replaces the element's contents wholesale, so anything not
 * named here is invisible to a screen reader no matter how it is marked up —
 * which is how the tokens' own hidden labels ended up unreachable. Everything
 * shown on the seat has to be listed.
 */
function describeSeat(player: Player): string {
  const parts = [`${player.name}, ${player.hp} of ${player.maxHp} hit points, row ${player.row}`]
  const tokens: [string, number][] = [
    ['Block', player.block],
    ['Strength', player.strength],
    ['Vulnerable', player.vulnerable],
    ['Weak', player.weak],
    ['Shivs', player.shivs],
    ['Miracles', player.miracles],
    ['Claw cubes', player.clawCubesGainedThisCombat ?? 0],
  ]
  for (const [label, value] of tokens) if (value > 0) parts.push(`${label} ${value}`)
  if (player.strengthLossAtEndOfTurn > 0) {
    parts.push(`Strength loss at end of turn ${player.strengthLossAtEndOfTurn}`)
  }
  if (player.drawLocked) parts.push('cannot draw more cards this turn')
  if ((player.doubledAttacksThisTurn ?? 0) > 0) {
    parts.push(`Double Tap, next ${player.doubledAttacksThisTurn} Attack${player.doubledAttacksThisTurn === 1 ? '' : 's'} played twice`)
  }
  if ((player.doubledCardsThisTurn ?? 0) > 0) {
    parts.push(`Echo Form, next ${player.doubledCardsThisTurn} Attack or Skill card${
      player.doubledCardsThisTurn === 1 ? '' : 's'
    } played twice`)
  }
  if ((player.doubledSkillsThisTurn ?? 0) > 0) {
    parts.push(`Burst, next ${player.doubledSkillsThisTurn} Skill${player.doubledSkillsThisTurn === 1 ? '' : 's'} played twice`)
  }
  if (player.hpLossLimitThisRound !== undefined) {
    parts.push(`Apparition protection, ${Math.max(0, player.hpLossLimitThisRound - (player.hpLostThisRound ?? 0))} hit point loss remaining this round`)
  }
  if (player.character === 'defect') {
    parts.push(`${player.orbs.filter(Boolean).length} of ${player.orbs.length} Orb slots occupied`)
  }
  for (const orb of player.orbs) if (orb) parts.push(`${orb} orb`)
  if (player.potions.length > 0) parts.push(`potions ${potionSummary(player)}`)
  if (player.stance !== 'neutral') parts.push(`${player.stance} stance`)
  // Powers are deliberately NOT listed here. They render as a sibling list
  // outside this button, with their own labels — naming them here as well had
  // a screen reader announce every Power twice.
  if (player.dead) parts.push('defeated')
  return parts.join(', ')
}

function potionSummary(player: Player): string {
  return [...new Set(player.potions)].map((potionId) => {
    const count = player.potions.filter((held) => held === potionId).length
    return `${potionDef(potionId).name}${count > 1 ? ` ×${count}` : ''}`
  }).join(', ')
}

/**
 * How far a card sits from the middle of the fan, from -1 to 1.
 *
 * A single card hangs straight; the spread narrows as the hand grows so a full
 * hand still fits the width it is given.
 */
function fanOf(index: number, count: number): number {
  if (count < 2) return 0
  return (index - (count - 1) / 2) / ((count - 1) / 2)
}

function canAfford(
  state: CombatState,
  player: Player,
  card: CardInstance,
  spendMiracle = false,
  drawCount = player.draw.length,
): boolean {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  if (!cardIsPlayable(def, state, player, drawCount)) return false
  const cost = playCost(def, player, card)
  if (spendMiracle && (cost === 'X' || cost === 0)) return false
  if (def.cost === 'X' && cost !== 'X' && (def.minimumX ?? 0) > 0) return false
  return cost === 'X'
    ? player.energy >= (def.minimumX ?? 0)
    : cost <= player.energy + (spendMiracle ? 1 : 0)
}

/**
 * Ids of everyone whose hit points just dropped, for ~400ms.
 *
 * A hit that only changes a number is a hit the player misses entirely. The
 * flinch animation already existed in the stylesheet; nothing ever applied it.
 */
function useStruck(state: CombatState): { struck: Set<string>; beat: number } {
  const previous = useRef(new Map<string, number>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [struck, setStruck] = useState<Set<string>>(new Set())
  // Bumped on every hit. Two blows on the same target inside the window leave
  // the class name unchanged, and an unchanged class never restarts a CSS
  // animation — so the second hit was not felt at all.
  const [beat, setBeat] = useState(0)

  useEffect(() => {
    const now = new Map<string, number>()
    const hurt = new Set<string>()
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.hp)
      const before = previous.current.get(id)
      if (before !== undefined && entity.hp < before) hurt.add(id)
    }
    previous.current = now
    if (hurt.size === 0) return

    // The timer lives in a ref rather than being cancelled by this effect's
    // cleanup. Cleaning it up there meant any later state change that hurt
    // nobody killed the pending "stop flinching" timer without scheduling a
    // replacement — so the class stuck forever and, being unchanged, never
    // re-triggered the animation again for the rest of the combat.
    setStruck(hurt)
    setBeat((count) => count + 1)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setStruck(new Set())
    }, 380)
  }, [state])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return { struck, beat }
}

export function CombatScreen({
  state,
  viewerId,
  onChange,
  onAction,
  drawCount,
  decidedPlayerIds,
  savedDiscardOrder,
  partyEndTurnAbilities,
  savedEndTurnOrder,
  endTurnCoordinatorId,
  partyStartTurnAbilities,
  partyStartTurnScryAbilities,
  startTurnCoordinatorId,
  partyStartTurnScry,
  cardPreview,
  authoritativeVersion,
  authoritativeRefresh,
}: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [miracleOnCard, setMiracleOnCard] = useState(false)
  const [spendingShiv, setSpendingShiv] = useState(false)
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [pendingPowerUid, setPendingPowerUid] = useState<string | null>(null)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingPower, setUsingPower] = useState(false)
  const [usingTrigger, setUsingTrigger] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const [endTurnOrder, setEndTurnOrder] = useState<string[]>([])
  const [endTurnError, setEndTurnError] = useState('')
  const [startTurnOrder, setStartTurnOrder] = useState<string[]>([])
  const [startTurnScryOrder, setStartTurnScryOrder] = useState<string[]>([])
  const [startTurnEnemyTargets, setStartTurnEnemyTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnTargets, setStartTurnTargets] = useState<Record<string, (string | null | undefined)[]>>({})
  const [startTurnEvokeSlots, setStartTurnEvokeSlots] = useState<Record<string, number[]>>({})
  const [startTurnEvokeTargets, setStartTurnEvokeTargets] = useState<
    Record<string, (string | null | undefined)[]>
  >({})
  const [startTurnScryPicked, setStartTurnScryPicked] = useState<string[]>([])
  const [resolvingStartTurnScry, setResolvingStartTurnScry] = useState(false)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnScryDialogRef = useRef<HTMLDialogElement | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const followViewerRow = useRef(true)
  const programmaticScrollTop = useRef<number | null>(null)
  const manualBoardScroll = useRef(false)
  const potionActionPending = useRef(false)
  const powerActionPending = useRef(false)
  const cardActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownPowerAction = useRef<UnknownPowerAction | null>(null)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
  const pendingTrigger = pendingTriggerAbility(state)
  const forcedCard = state.startTurnProgress?.forcedCard
  const activeStartTurnScry = partyStartTurnScry ?? (!onAction ? startTurnScryPreview(state) : undefined)
  const startTurnScryKey = activeStartTurnScry
    ? `${activeStartTurnScry.playerId}:${activeStartTurnScry.label}:${activeStartTurnScry.cards?.map((card) => card.uid).join(',') ?? 'hidden'}`
    : ''
  const baseStartTurnScries = state.phase === 'start' && !activeStartTurnScry && !pendingTrigger
    ? (partyStartTurnScryAbilities ?? startTurnScryAbilities(state))
    : []
  const startTurnScryIds = startTurnScryOrder.length === baseStartTurnScries.length &&
    startTurnScryOrder.every((id) => baseStartTurnScries.some((ability) => ability.id === id))
    ? startTurnScryOrder
    : baseStartTurnScries.map((ability) => ability.id)
  const orderedStartTurnScries = startTurnScryIds.map((id) =>
    baseStartTurnScries.find((ability) => ability.id === id)).filter((ability) => ability !== undefined)
  const forcedCardUid = forcedCard?.playerId === viewerId && typeof forcedCard.cardUid === 'string'
    ? forcedCard.cardUid
    : null
  const stateRef = useRef(state)
  const versionRef = useRef(authoritativeVersion ?? -1)
  const refreshRef = useRef(authoritativeRefresh)
  stateRef.current = state
  versionRef.current = authoritativeVersion ?? -1
  refreshRef.current = authoritativeRefresh
  const rows = useMemo(() => rowsOf(state), [state])
  const savedDiscardKey = savedDiscardOrder?.join('\0')
  const savedEndTurnKey = savedEndTurnOrder?.join('\0')
  const cardPreviewKey = cardPreview
    ? `${cardPreview.cardUid}\0${cardPreview.copy === true}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''
  const orderingStage = partyEndTurnAbilities !== undefined
  const baseStartAbilities = state.phase === 'start' && !pendingTrigger
    ? (partyStartTurnAbilities ?? startTurnAbilities(state))
    : []
  const startAbilityKey = baseStartAbilities.map((ability) =>
    `${ability.id}:${ability.overflowShivs}:${ability.targets?.map((target) => target.uid).join(',') ?? ''}:` +
    `${ability.evokeChoice?.options.map((option) => `${option.slot}:${option.orb}`).join(',') ?? ''}`).join('\0')

  const { struck, beat } = useStruck(state)

  // Unknown delivery with the item still visible stays locked until a causally
  // later REST refresh. Exact inventory evidence can recognize a commit sooner.
  useEffect(() => {
    const current = state.players.find((player) => player.id === viewerId)
    const potion = unknownPotionAction.current
    if (potion && (
      (authoritativeRefresh !== undefined && authoritativeRefresh > potion.refreshAttempt) ||
      (current && current.potions.filter((held) => held === potion.potionId).length < potion.countBefore)
    )) {
      unknownPotionAction.current = null
      potionActionPending.current = false
      setUsingPotion(false)
    }
    const power = unknownPowerAction.current
    if (power && current) {
      const used = current.powers.some((held) => held.uid === power.powerUid) &&
        state.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewerId, power.powerUid))
      const refreshed = authoritativeRefresh !== undefined && authoritativeRefresh > power.refreshAttempt
      if (used || refreshed) {
        unknownPowerAction.current = null
        powerActionPending.current = false
        setUsingPower(false)
        if (!used && state.phase === 'player' && !state.startTurnProgress?.forcedCard &&
          current.powers.some((held) => held.uid === power.powerUid)) setPendingPowerUid(power.powerUid)
      }
    }
    const card = unknownCardAction.current
    const cardCommitted = card?.copy
      ? state.pendingCardCopy?.card.uid !== card.cardUid ||
        (card.copiesBefore !== undefined && state.pendingCardCopy.sourceNames.length < card.copiesBefore)
      : current && !current.hand.some((held) => held.uid === card?.cardUid)
    if (card && ((authoritativeRefresh !== undefined && authoritativeRefresh > card.refreshAttempt) || cardCommitted)) {
      unknownCardAction.current = null
      cardActionPending.current = false
      setUsingCard(false)
    }
  }, [authoritativeRefresh, state, viewerId])

  useEffect(() => {
    if (pendingPowerUid && (state.startTurnProgress?.forcedCard ||
      !viewer?.powers.some((power) => power.uid === pendingPowerUid) ||
      powerAbilityUsed(state, viewerId, pendingPowerUid))) setPendingPowerUid(null)
  }, [pendingPowerUid, state.powerTriggersUsedThisTurn, state.startTurnProgress?.forcedCard, viewer?.powers, viewerId])

  function recenterViewerRow() {
    const board = boardRef.current
    revealViewerRow(board, viewerRowRef.current)
    programmaticScrollTop.current = board?.scrollTop ?? null
  }

  // Drop stale targeting when the phase, seat, or mandatory trigger changes.
  useEffect(() => {
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, viewerId, pendingTrigger?.id])

  useEffect(() => {
    if (!orderingStage) return
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [orderingStage])

  // A private reveal is room state, not transient component state: restore it
  // after a reconnect so the player must finish the card they already saw.
  useEffect(() => {
    if (!cardPreview || !viewer) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' ? null : current)
      return
    }
    if (usingCard) return
    const copied = cardPreview.copy === true && state.pendingCardCopy?.playerId === viewer.id
    const card = copied
      ? state.pendingCardCopy!.card
      : viewer.hand.find((held) => held.uid === cardPreview.cardUid)
    if (!card) {
      if (onAction) setPending((current) => current?.choiceCards &&
        current.choice?.kind !== 'recover' && current.choice?.kind !== 'recoverExhaust' ? null : current)
      return
    }
    const next = pendingFor(card, cardPreview.cards, state, viewer, !copied,
      copied ? state.pendingCardCopy?.energySpent : undefined)
    if (next.choice?.kind !== cardPreview.kind) return
    setMiracleOnCard(cardPreview.spendMiracle)
    const restored = { ...next, enemyUid: cardPreview.enemyUid }
    setPending((current) => current?.card.uid === card.uid &&
      current.choice?.kind === cardPreview.kind &&
      current.enemyUid === cardPreview.enemyUid &&
      current.choiceCards?.length === cardPreview.cards.length &&
      current.choiceCards?.every((held, index) => held.uid === cardPreview.cards[index]?.uid)
      ? current : restored)
  }, [cardPreviewKey, viewerId, usingCard, onAction])

  useEffect(() => {
    const copy = state.pendingCardCopy
    if (state.phase !== 'copy' || !copy || copy.playerId !== viewerId || !viewer || cardPreview || usingCard) return
    const def = faceOf(cardDef(copy.card.defId), copy.card.upgraded)
    if (cardNeedsChoicePreview(def, state, viewer)) {
      if (cardNeedsEnemy(def, viewer, false, copy.energySpent)) {
        setPending({ ...pendingFor(copy.card, null, state, viewer, false, copy.energySpent), choice: null })
      } else requestCopyChoicePreview()
      return
    }
    const next = pendingFor(copy.card, null, state, viewer, false, copy.energySpent)
    setPending(next)
    stageOrCommit(next)
  }, [state.phase, state.pendingCardCopy?.card.uid, state.pendingCardCopy?.sourceNames.length,
    viewerId, cardPreviewKey, usingCard])

  // Native modal semantics make every control behind a card choice inert and
  // keep keyboard focus inside it without a custom focus trap. Hidden reveals
  // prevent cancellation; Headbutt's already-public discard choice does not.
  useEffect(() => {
    const dialog = choiceDialogRef.current
    if (!dialog) return
    if (pending?.choiceCards && !pending.choiceConfirmed) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [pending?.choiceCards, pending?.choiceConfirmed])

  useEffect(() => {
    setStartTurnScryPicked([])
    setResolvingStartTurnScry(false)
  }, [startTurnScryKey])

  useEffect(() => {
    const dialog = startTurnScryDialogRef.current
    const owned = activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards !== null
    if (owned) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [startTurnScryKey, activeStartTurnScry?.playerId, activeStartTurnScry?.cards, viewerId])

  // A teammate can spend Shivs or kill a staged target while this client is
  // choosing Cunning Potion's overflow attacks. Restart a changed count and
  // drop dead targets instead of submitting choices for an older board.
  useEffect(() => {
    if (!pendingPotion) return
    if (!viewer?.potions.includes(pendingPotion)) {
      setPendingPotion(null)
      setPotionShivEnemyUids([])
      setPotionOverflowRequired(0)
      return
    }
    const gained = gainedShivs(potionDef(pendingPotion).effects)
    if (gained === 0) return
    const liveRequired = overflowShivCount(state, gained)
    if (liveRequired !== potionOverflowRequired) {
      setPotionShivEnemyUids([])
      setPotionOverflowRequired(liveRequired)
      if (liveRequired === 0) setPendingPotion(null)
      return
    }
    const alive = new Set(state.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    setPotionShivEnemyUids((current) => {
      const valid = current.filter((uid) => alive.has(uid))
      return valid.length === current.length ? current : valid
    })
  }, [state, viewer, pendingPotion, potionOverflowRequired])

  // Card choices are made against a shared board too. Recompute overflow when
  // teammates take or spend cubes, and discard targets that died meanwhile.
  useEffect(() => {
    if (!viewer) return
    const alive = new Set(state.enemies.filter((enemy) => !enemy.dead).map((enemy) => enemy.uid))
    const livingPlayers = new Set(state.players.filter((player) => !player.dead).map((player) => player.id))
    setPending((current) => {
      if (!current) return current
      if (current.cardInHand
        ? !viewer.hand.some((card) => card.uid === current.card.uid)
        : state.pendingCardCopy?.playerId !== viewer.id || state.pendingCardCopy.card.uid !== current.card.uid) return null
      const def = faceOf(cardDef(current.card.defId), current.card.upgraded)
      if (current.cardInHand && !cardPlayConditionMet(def, state, viewer, drawCount)) return null
      const recover = def.effects.find((effect) => effect.kind === 'recoverDiscard')
      const recoverExhaust = def.effects.find((effect) => effect.kind === 'recoverExhaust')
      const recoveryCards = recover ? viewer.discard : recoverExhaust ? viewer.exhaust : null
      if ((recover || recoverExhaust) && recoveryCards?.length === 0) return null
      const choice = recover
        ? viewer.discard.length > 0 ? { kind: 'recover' as const, amount: recover.amount } : null
        : recoverExhaust
          ? viewer.exhaust.length > 0
            ? { kind: 'recoverExhaust' as const, amount: recoverExhaust.amount }
            : null
        : current.choice
      const choiceCards = recoveryCards ? (recoveryCards.length > 0 ? recoveryCards : null) : current.choiceCards
      const choiceCardsChanged = choiceCards?.length !== current.choiceCards?.length ||
        choiceCards?.some((card, index) => card.uid !== current.choiceCards?.[index]?.uid) === true
      const overflowShivs = overflowShivCount(state,
        cardShivsOnPlay(def, current.choice?.kind === 'discardAny' ? current.picked.length : 0))
      const overflowChanged = overflowShivs !== current.overflowShivs
      const spentShivs = cardShivChoiceCount(def, viewer)
      const spentChanged = spentShivs !== current.spentShivs
      const enemyChoices = cardEnemyChoiceCount(def)
      const playerChoices = cardPlayerChoiceCount(def)
      const enemyUid = current.enemyUid && alive.has(current.enemyUid) ? current.enemyUid : null
      const enemyUids = current.enemyUids.filter((uid) => alive.has(uid))
      const playerIds = current.playerIds.filter((id) => livingPlayers.has(id))
      const picked = choiceCards
        ? recover || recoverExhaust
          ? current.picked.filter((uid) => choiceCards.some((card) => card.uid === uid))
          : current.picked
        : current.picked.filter((uid) => viewer.hand.some((card) => card.uid === uid))
      const pickedChanged = picked.length !== current.picked.length
      const minimumUnpaid = current.choice?.kind === 'exhaustAny' && current.choiceConfirmed &&
        picked.length < Math.min(current.choice.minimum ?? 0,
          Math.max(0, viewer.hand.length - Number(current.cardInHand)))
      const shivEnemyUids = overflowChanged || spentChanged
        ? []
        : current.shivEnemyUids.filter((uid) => alive.has(uid))
      const needsEnemy = cardNeedsEnemy(def, viewer, false, current.energySpent ?? undefined) || spentShivs > 0 ||
        overflowShivs > 0 || enemyChoices > 0
      const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') && livingPlayers.size > 1
      const switchTargetAlive = current.switchPlayerId === null || livingPlayers.has(current.switchPlayerId)
      const switchPlayerId = switchTargetAlive ? current.switchPlayerId : null
      const switchChoiceDone = !needsSwitch || (current.switchChoiceDone && switchTargetAlive)
      const invalidEvokeTarget = current.evokeEnemyUids.some((target) => {
        if (typeof target !== 'string') return false
        const row = lightningRowFromTarget(target)
        return row === null
          ? !alive.has(target)
          : !lightningTargetsRows(viewer, def.id) || !rowsOf(state).includes(row)
      })
      const evokeSlots = invalidEvokeTarget ? [] : current.evokeSlots
      const evokeEnemyUids = invalidEvokeTarget ? [] : current.evokeEnemyUids
      if (overflowChanged && !needsEnemy && !current.needsAlly && !needsSwitch && !current.choice &&
        !nextEvokeChoice(def, viewer, evokeSlots, current.mode ?? undefined, current.energySpent ?? 0) &&
        !evokeEnemyUids.some((target) => target === undefined)) return null
      if (
        overflowShivs === current.overflowShivs &&
        spentShivs === current.spentShivs &&
        enemyUid === current.enemyUid &&
        enemyUids.length === current.enemyUids.length &&
        playerIds.length === current.playerIds.length &&
        choice?.kind === current.choice?.kind &&
        !choiceCardsChanged &&
        !pickedChanged &&
        !minimumUnpaid &&
        shivEnemyUids.length === current.shivEnemyUids.length &&
        needsSwitch === current.needsSwitch &&
        switchPlayerId === current.switchPlayerId &&
        switchChoiceDone === current.switchChoiceDone &&
        !invalidEvokeTarget
      ) return current
      return {
        ...current,
        overflowShivs,
        spentShivs,
        needsEnemy,
        needsSwitch,
        enemyChoices,
        playerChoices,
        enemyUid,
        enemyUids,
        playerIds,
        choice,
        choiceCards,
        picked,
        switchPlayerId,
        switchChoiceDone,
        shivEnemyUids,
        choiceConfirmed: (pickedChanged || choiceCardsChanged || minimumUnpaid ||
          (overflowChanged && overflowShivs === 0)) &&
          (current.choice?.kind === 'discardAny' || current.choice?.kind === 'exhaustAny' ||
            current.choice?.kind === 'recover' || current.choice?.kind === 'recoverExhaust')
          ? false
          : current.choiceConfirmed,
        evokeSlots,
        evokeEnemyUids,
      }
    })
  }, [state, viewer, drawCount])

  useEffect(() => {
    if (onAction) return
    potionActionPending.current = false
    setUsingPotion(false)
  }, [onAction, state])

  useEffect(() => {
    if (state.phase !== 'discard') {
      setDiscardTops({})
      setRetainedCards({})
      setDiscardOrders({})
    }
    if (state.phase !== 'player') setEndTurnOrder([])
    if (state.phase !== 'start') {
      setStartTurnOrder([])
      setStartTurnEnemyTargets({})
      setStartTurnTargets({})
      setStartTurnEvokeSlots({})
      setStartTurnEvokeTargets({})
    }
  }, [state.phase])

  useEffect(() => {
    if (state.phase !== 'start') return
    setStartTurnOrder(baseStartAbilities.map((ability) => ability.id))
    setStartTurnEnemyTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined,
    ])))
    setStartTurnTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      Array(ability.overflowShivs).fill(undefined),
    ])))
    setStartTurnEvokeSlots(Object.fromEntries(baseStartAbilities.map((ability) => [ability.id, []])))
    setStartTurnEvokeTargets(Object.fromEntries(baseStartAbilities.map((ability) => [ability.id, []])))
  }, [startAbilityKey, state.phase])

  useEffect(() => {
    if (state.phase !== 'discard' || !savedDiscardOrder) return
    setDiscardOrders({ [viewerId]: savedDiscardOrder })
    const ordered = new Set(savedDiscardOrder)
    setRetainedCards({
      [viewerId]: viewer?.hand.filter((card) => !ordered.has(card.uid) && !card.endTurnProtected &&
        !faceOf(cardDef(card.defId), card.upgraded).retain).map((card) => card.uid) ?? [],
    })
    const top = savedDiscardOrder.at(-1)
    if (top) setDiscardTops({ [viewerId]: top })
  }, [savedDiscardKey, state.phase, viewerId])

  useEffect(() => {
    if (state.phase !== 'player' || !savedEndTurnOrder) return
    setEndTurnOrder(savedEndTurnOrder)
  }, [savedEndTurnKey, state.phase, viewerId])

  // Newest-first means a scrolled log stays where the player left it, so a new
  // line lands above the visible area and is never seen.
  const logRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0
  }, [state.log.length])
  const bosses = state.enemies.filter((enemy) => enemy.isBoss)

  // With a full party the board can outgrow the viewport. Rather than shrink
  // everything, keep the row the player actually controls on screen.
  //
  // A layout effect, not a plain one: this must run before paint, or the board
  // is briefly drawn scrolled to the wrong row and then jumps.
  // Also on a phase change: the log grows during the Enemy Turn and the pause,
  // which shrinks the board while `scrollTop` stays where it was — pushing the
  // row you control, and the enemy you are fighting, out of view exactly when
  // you are meant to be reading them.
  useLayoutEffect(() => {
    followViewerRow.current = true
    recenterViewerRow()
  }, [viewerId, state.turn, state.phase])

  useLayoutEffect(() => {
    if (followViewerRow.current) recenterViewerRow()
  }, [state.log.length])

  useEffect(() => {
    const board = boardRef.current
    if (!board || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followViewerRow.current) recenterViewerRow()
    })
    observer.observe(board)
    for (const row of board.querySelectorAll('.row')) observer.observe(row)
    return () => observer.disconnect()
  }, [viewerId])

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const inspectElsewhere = () => {
      if (
        programmaticScrollTop.current !== null &&
        Math.abs(board.scrollTop - programmaticScrollTop.current) < 1
      ) {
        programmaticScrollTop.current = null
        return
      }
      programmaticScrollTop.current = null
      if (manualBoardScroll.current) {
        manualBoardScroll.current = false
        followViewerRow.current = false
      }
    }
    const armScroll = () => { manualBoardScroll.current = true }
    const armKeyboardScroll = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) armScroll()
    }
    const armScrollbar = (event: PointerEvent) => {
      if (event.target === board) armScroll()
    }
    const releasePointer = () => requestAnimationFrame(() => { manualBoardScroll.current = false })
    board.addEventListener('wheel', armScroll, { passive: true })
    board.addEventListener('touchmove', armScroll, { passive: true })
    board.addEventListener('pointerdown', armScrollbar)
    board.addEventListener('pointerup', releasePointer)
    board.addEventListener('keydown', armKeyboardScroll)
    board.addEventListener('scroll', inspectElsewhere, { passive: true })
    return () => {
      board.removeEventListener('wheel', armScroll)
      board.removeEventListener('touchmove', armScroll)
      board.removeEventListener('pointerdown', armScrollbar)
      board.removeEventListener('pointerup', releasePointer)
      board.removeEventListener('keydown', armKeyboardScroll)
      board.removeEventListener('scroll', inspectElsewhere)
    }
  }, [viewerId])

  // And again whenever the viewport changes shape. The scroll position is
  // measured in pixels against the old layout, so rotating a phone or resizing
  // a window left the player's own row — and the enemy they are fighting —
  // scrolled off the board.
  useEffect(() => {
    const reveal = () => {
      followViewerRow.current = true
      recenterViewerRow()
    }
    window.addEventListener('resize', reveal)
    return () => window.removeEventListener('resize', reveal)
  }, [])

  if (!viewer) return <p className="muted">No seat for {viewerId}.</p>

  const over = state.phase === 'won' || state.phase === 'lost'
  const pendingPotionDef = pendingPotion ? potionDef(pendingPotion) : null
  const pendingPower = pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingPotionOverflow = potionOverflowRequired
  const livingPlayers = state.players.filter((player) => !player.dead)
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !faceOf(cardDef(card.defId), card.upgraded).retain)
  const retainAllowance = viewer.retainCardsThisTurn ?? 0
  const viewerRetainedCards = (retainedCards[viewer.id] ?? [])
    .filter((uid) => discardableHand.some((card) => card.uid === uid))
    .slice(0, retainAllowance)
  const retainedSet = new Set(viewerRetainedCards)
  const discardCandidates = discardableHand.filter((card) => !retainedSet.has(card.uid))
  const viewerDiscardTop = discardTops[viewer.id] && discardCandidates.some((card) => card.uid === discardTops[viewer.id])
    ? discardTops[viewer.id]
    : discardCandidates.at(-1)?.uid ?? ''
  const abilities = onAction ? (partyEndTurnAbilities ?? []) : endTurnAbilities(state)
  const defaultOrder = defaultEndTurnOrder(abilities)
  const viewerEndTurnOrder = validEndTurnOrder(abilities, endTurnOrder)
    ? endTurnOrder
    : defaultOrder
  const canOrderEndTurn = !orderingStage || viewer.id === endTurnCoordinatorId
  const startIds = startTurnOrder.length === baseStartAbilities.length
    ? startTurnOrder
    : baseStartAbilities.map((ability) => ability.id)
  const startChoiceDrafts: StartTurnChoice[] = startIds.map((id) => ({
    id,
    enemyUid: startTurnEnemyTargets[id],
    shivEnemyUids: (startTurnTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
    evokeSlots: startTurnEvokeSlots[id] ?? [],
    evokeEnemyUids: (startTurnEvokeTargets[id] ?? [])
      .filter((uid): uid is string | null => uid !== undefined),
  }))
  const orderedStartAbilities = startTurnAbilities(state, startIds, startChoiceDrafts)
  const canResolveStartTurn = !onAction || viewer.id === startTurnCoordinatorId
  const pendingStartChoice = canResolveStartTurn
    ? orderedStartAbilities.flatMap<PendingStartChoice>((ability) => {
      if (ability.targets &&
        (startTurnEnemyTargets[ability.id] === undefined || ability.enemyTargetStale)) {
        return [{ kind: 'enemy', ability }]
      }
      const shivIndex = Array.from({ length: ability.overflowShivs })
        .findIndex((_unused, index) => startTurnTargets[ability.id]?.[index] === undefined ||
          ability.staleShivIndex === index)
      if (shivIndex >= 0) return [{ kind: 'shiv', ability, index: shivIndex }]
      if (ability.evokeTargetIndex !== undefined) {
        return [{ kind: 'evokeTarget', ability, index: ability.evokeTargetIndex }]
      }
      return ability.evokeChoice ? [{ kind: 'evoke', ability }] : []
    })[0]
    : undefined
  const pendingStartEnemy = pendingStartChoice?.kind === 'enemy' ? pendingStartChoice.ability : undefined
  const pendingStartShiv = pendingStartChoice?.kind === 'shiv' ? pendingStartChoice : undefined
  const pendingStartEvokeTarget = pendingStartChoice?.kind === 'evokeTarget' ? pendingStartChoice : undefined
  const pendingStartEvoke = pendingStartChoice?.kind === 'evoke' ? pendingStartChoice.ability : undefined
  const pendingStartEvokeRows = pendingStartEvokeTarget?.ability.evokeTargets?.flatMap((target) => {
    const row = lightningRowFromTarget(target.uid)
    return row === null ? [] : [{ row, uid: target.uid }]
  }) ?? []
  const startTurnReady = orderedStartAbilities.length === baseStartAbilities.length &&
    !pendingStartEnemy && !pendingStartShiv && !pendingStartEvokeTarget && !pendingStartEvoke
  const isStartTurnEnemyTarget = (enemyUid: string) =>
    Boolean(pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid)) ||
    Boolean(pendingStartShiv && (!pendingStartShiv.ability.shivTargets ||
      pendingStartShiv.ability.shivTargets.some((target) => target.uid === enemyUid))) ||
    Boolean(pendingStartEvokeTarget?.ability.evokeTargets?.some((target) => target.uid === enemyUid))

  function moveStartTurnAbility(id: string, delta: -1 | 1) {
    const from = startIds.indexOf(id)
    const to = from + delta
    if (!canResolveStartTurn || from < 0 || to < 0 || to >= startIds.length) return
    const order = [...startIds]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    const plan = startTurnAbilities(state, order)
    setStartTurnOrder(order)
    setStartTurnEnemyTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined,
    ])))
    setStartTurnTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      Array(ability.overflowShivs).fill(undefined),
    ])))
    setStartTurnEvokeSlots(Object.fromEntries(plan.map((ability) => [ability.id, []])))
    setStartTurnEvokeTargets(Object.fromEntries(plan.map((ability) => [ability.id, []])))
  }

  function chooseStartTurnEnemy(enemyUid: string) {
    if (!pendingStartEnemy || !canResolveStartTurn) return
    if (!pendingStartEnemy.targets?.some((target) => target.uid === enemyUid)) return
    setStartTurnEnemyTargets({ ...startTurnEnemyTargets, [pendingStartEnemy.id]: enemyUid })
  }

  function chooseStartTurnShiv(enemyUid: string | null) {
    if (!pendingStartShiv || !canResolveStartTurn) return
    if (enemyUid !== null && pendingStartShiv.ability.shivTargets &&
      !pendingStartShiv.ability.shivTargets.some((target) => target.uid === enemyUid)) return
    const targets = [...(startTurnTargets[pendingStartShiv.ability.id] ?? [])]
    targets[pendingStartShiv.index] = enemyUid
    setStartTurnTargets({ ...startTurnTargets, [pendingStartShiv.ability.id]: targets })
  }

  function chooseStartTurnEvoke(slot: number) {
    if (!pendingStartEvoke?.evokeChoice || !canResolveStartTurn) return
    const picked = pendingStartEvoke.evokeChoice.options.find((option) => option.slot === slot)
    if (!picked) return
    const evokeSlots = [...(startTurnEvokeSlots[pendingStartEvoke.id] ?? []), slot]
    setStartTurnEvokeSlots({
      ...startTurnEvokeSlots,
      [pendingStartEvoke.id]: evokeSlots,
    })
    const existingTargets = startTurnEvokeTargets[pendingStartEvoke.id] ?? []
    const fallbackTarget = [
      ...Object.values(startTurnEvokeTargets).flat(),
      ...Object.values(startTurnTargets).flat(),
      ...Object.values(startTurnEnemyTargets),
    ].reverse().find((uid): uid is string => typeof uid === 'string')
    const nextDrafts = startChoiceDrafts.map((choice) => choice.id === pendingStartEvoke.id
      ? { ...choice, evokeSlots }
      : choice)
    const evokeOrbs = startTurnAbilities(state, startIds, nextDrafts)
      .find((ability) => ability.id === pendingStartEvoke.id)?.evokeOrbs ?? [picked.orb]
    setStartTurnEvokeTargets({
      ...startTurnEvokeTargets,
      [pendingStartEvoke.id]: [
        ...existingTargets,
        ...evokeOrbs.slice(existingTargets.length).map((orb) => orb === 'frost'
          ? null
          : pendingStartEvoke.evokeTargets?.length === 0 ? fallbackTarget : undefined),
      ],
    })
  }

  function chooseStartTurnEvokeEnemy(enemyUid: string) {
    if (!pendingStartEvokeTarget || !canResolveStartTurn) return
    if (!pendingStartEvokeTarget.ability.evokeTargets?.some((target) => target.uid === enemyUid)) return
    const targets = [...(startTurnEvokeTargets[pendingStartEvokeTarget.ability.id] ?? [])]
    targets[pendingStartEvokeTarget.index] = enemyUid
    setStartTurnEvokeTargets({ ...startTurnEvokeTargets, [pendingStartEvokeTarget.ability.id]: targets })
  }

  function moveStartTurnScry(id: string, delta: -1 | 1) {
    const from = startTurnScryIds.indexOf(id)
    const to = from + delta
    if (!canResolveStartTurn || from < 0 || to < 0 || to >= startTurnScryIds.length) return
    const order = [...startTurnScryIds]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    setStartTurnScryOrder(order)
  }

  function finishStartTurnScryOrder() {
    if (!canResolveStartTurn || orderedStartTurnScries.length !== baseStartTurnScries.length) return
    if (onAction) onAction({ kind: 'orderStartTurnScries', order: startTurnScryIds })
    else onChange?.(orderStartTurnScries(state, startTurnScryIds))
  }

  function chooseStartTurnScryCard(card: CardInstance) {
    if (!activeStartTurnScry?.cards || resolvingStartTurnScry) return
    setStartTurnScryPicked((picked) => picked.includes(card.uid)
      ? picked.filter((uid) => uid !== card.uid)
      : [...picked, card.uid])
  }

  async function finishStartTurnScry() {
    if (!activeStartTurnScry?.cards || activeStartTurnScry.playerId !== viewerId || resolvingStartTurnScry) return
    setResolvingStartTurnScry(true)
    if (onAction) {
      await onAction({
        kind: 'resolveStartTurnScry', sourceId: activeStartTurnScry.id, discardUids: startTurnScryPicked,
      })
      setResolvingStartTurnScry(false)
      return
    }
    onChange?.(resolveStartTurnScry(state, viewerId, activeStartTurnScry.id, startTurnScryPicked))
    setResolvingStartTurnScry(false)
  }

  function finishStartTurn() {
    if (!startTurnReady || !canResolveStartTurn) return
    const choices: StartTurnChoice[] = orderedStartAbilities.map((ability) => ({
      id: ability.id,
      enemyUid: startTurnEnemyTargets[ability.id],
      shivEnemyUids: (startTurnTargets[ability.id] ?? []).map((uid) => uid ?? null),
      evokeSlots: [...(startTurnEvokeSlots[ability.id] ?? [])],
      evokeEnemyUids: (startTurnEvokeTargets[ability.id] ?? []).map((uid) => uid ?? null),
    }))
    if (onAction) onAction({ kind: 'resolveStartTurn', choices })
    else onChange?.(resolveStartPlayerTurn(state, choices))
  }

  function beginNextTurn() {
    if (onAction) {
      onAction({ kind: 'startTurn' })
      return
    }
    onChange?.(startPlayerTurnWithChoices(state))
  }

  function moveEndTurnAbility(id: string, delta: -1 | 1) {
    const from = viewerEndTurnOrder.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= viewerEndTurnOrder.length) return
    const order = [...viewerEndTurnOrder]
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    setEndTurnOrder(order)
    setEndTurnError('')
  }

  function targetEndTurnAbility(choice: string, targetUid: string) {
    setEndTurnOrder(viewerEndTurnOrder.map((candidate) => candidate === choice
      ? chooseEndTurnTarget(candidate, targetUid)
      : candidate))
    setEndTurnError('')
  }

  function finishTurn() {
    if (!viewer) return
    if (pending?.choiceCards) return
    if (state.phase === 'player') {
      const order: EndTurnOrder = viewerEndTurnOrder
      if (orderingStage) {
        if (viewer.id === endTurnCoordinatorId) onAction?.({ kind: 'resolveEndTurn', abilityOrder: order })
      } else if (onAction) onAction({ kind: 'endTurn' })
      else {
        const next = beginEndPlayerTurn(state, order)
        if (next === state) setEndTurnError('Choose a living target for every Lightning Orb, then try again.')
        else {
          setEndTurnError('')
          onChange?.(next)
        }
      }
      return
    }
    const selected = discardTops[viewer.id]
    const top = selected && discardCandidates.some((card) => card.uid === selected)
      ? selected
      : discardCandidates.at(-1)?.uid
    const cardsToDiscard = viewer.hand.filter((card) => !retainedSet.has(card.uid))
    const order = top
      ? [...cardsToDiscard.filter((card) => card.uid !== top), viewer.hand.find((card) => card.uid === top)!]
      : cardsToDiscard
    const orders = { ...discardOrders, [viewer.id]: order.map((card) => card.uid) }
    if (onAction) {
      onAction({ kind: 'discardHand', discardOrder: orders[viewer.id] })
      return
    }
    if (livingPlayers.every((player) => orders[player.id])) {
      setDiscardTops({})
      setDiscardOrders({})
      onChange?.(endPlayerTurn(state, orders))
    } else {
      setDiscardOrders(orders)
    }
  }

  function reconciliation(outcome: ActionOutcome | void) {
    const snapshot = outcome?.snapshot
    if (!snapshot?.run?.combat || snapshot.version < versionRef.current) return null
    const combat = snapshot.version === versionRef.current ? stateRef.current : snapshot.run.combat
    const player = combat.players.find((candidate) => candidate.id === viewerId)
    return (combat.phase === 'player' || combat.phase === 'copy') && player ? { combat, player } : null
  }

  function consumePotion(
    potionId: string,
    context: PotionContext = {},
    overflow?: { expected: number; skip: boolean },
  ) {
    if (potionActionPending.current) return
    // Preview the atomic action against the visible board. Separate overflow
    // attacks may kill a target selected again later; keep the potion staged
    // and restart its choices instead of clearing the UI for a refused action.
    const result = activatePotion(state, viewer!.id, potionId, context)
    if (result === state) {
      if (context.shivEnemyUids?.length) setPotionShivEnemyUids([])
      return
    }
    potionActionPending.current = true
    setUsingPotion(true)
    setPending(null)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    if (onAction) {
      const potionCountBefore = viewer!.potions.filter((held) => held === potionId).length
      const unlock = () => {
        unknownPotionAction.current = null
        potionActionPending.current = false
        setUsingPotion(false)
      }
      const awaitReconciliation = (refreshAttempt = refreshRef.current) => {
        setTimeout(() => {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          if (
            (current && current.potions.filter((held) => held === potionId).length < potionCountBefore) ||
            (refreshAttempt !== undefined && refreshRef.current !== undefined && refreshRef.current > refreshAttempt)
          ) unlock()
          else if (refreshAttempt !== undefined) {
            unknownPotionAction.current = { refreshAttempt, potionId, countBefore: potionCountBefore }
          } else unlock()
        }, 0)
      }
      const retry = (outcome: ActionOutcome | void) => {
        if (outcome?.status !== 'refused' && outcome?.status !== 'reconciled') return
        const authoritative = reconciliation(outcome)
        if (!authoritative) return
        const count = authoritative.player.potions.filter((held) => held === potionId).length
        if (count === 0 || (outcome.status === 'reconciled' && count < potionCountBefore)) return
        const def = potionDef(potionId)
        const liveOverflow = overflowShivCount(authoritative.combat, gainedShivs(def.effects))
        const needsTarget = Boolean(def.target) || (
          def.supportTarget === 'anyPlayer' && authoritative.combat.players.filter((player) => !player.dead).length > 1
        ) || liveOverflow > 0
        if (!needsTarget) return
        setPendingPotion(potionId)
        setPotionShivEnemyUids([])
        setPotionOverflowRequired(liveOverflow)
      }
      Promise.resolve(onAction({
        kind: 'usePotion',
        potionId,
        ...context,
        preflight: true,
        expectedShivOverflow: overflow?.expected,
        skipOverflow: overflow?.skip,
      })).then((outcome) => {
        if (outcome?.status === 'unknown') {
          awaitReconciliation(outcome.refreshAttempt)
          return
        }
        retry(outcome)
        unlock()
      }, () => {
        awaitReconciliation()
      })
      return
    }
    onChange?.(result)
  }

  function usePower(powerUid: string, context: PowerContext) {
    if (powerActionPending.current) return
    const result = activatePower(state, viewer!.id, powerUid, context)
    if (result === state) return
    powerActionPending.current = true
    setUsingPower(true)
    setPendingPowerUid(null)
    if (!onAction) {
      powerActionPending.current = false
      setUsingPower(false)
      onChange?.(result)
      return
    }
    const unlock = () => {
      unknownPowerAction.current = null
      powerActionPending.current = false
      setUsingPower(false)
    }
    const waitForRefresh = (refreshAttempt = refreshRef.current) => {
      const current = stateRef.current
      if (current.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid))) {
        unlock()
      } else if (refreshAttempt !== undefined) {
        unknownPowerAction.current = { refreshAttempt, powerUid }
      } else {
        unlock()
        setPendingPowerUid(powerUid)
      }
    }
    Promise.resolve(onAction({ kind: 'activatePower', powerUid, ...context, preflight: true })).then((outcome) => {
      if (outcome?.status === 'unknown') {
        waitForRefresh(outcome.refreshAttempt)
        return
      }
      if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
        const authoritative = reconciliation(outcome)
        const held = authoritative?.player.powers.find((power) => power.uid === powerUid)
        if (held && !authoritative!.combat.startTurnProgress?.forcedCard &&
          !authoritative!.combat.powerTriggersUsedThisTurn.includes(powerAbilityKey(viewer!.id, powerUid))) {
          setPendingPowerUid(powerUid)
        }
      }
      unlock()
    }, () => waitForRefresh())
  }

  function resolveTrigger(enemyRow?: number, enemyUid?: string) {
    const trigger = pendingTrigger
    if (usingTrigger || !trigger || trigger.playerId !== viewer?.id) return
    const result = resolvePendingTrigger(state, viewer!.id, trigger.id, enemyRow, enemyUid)
    if (result === state) return
    if (!onAction) {
      onChange?.(result)
      return
    }
    setUsingTrigger(true)
    Promise.resolve(onAction({
      kind: 'resolveTrigger', triggerId: trigger.id, enemyRow, enemyUid, preflight: true,
    }))
      .finally(() => setUsingTrigger(false))
  }
  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ??
    Math.max(0, viewer.hand.length - Number(pending?.cardInHand ?? true))
  const variableMinimum = Math.min(pending?.choice?.minimum ?? 0, choicePoolSize)
  const choiceNeeded = pending?.choice && pending.choice.kind !== 'scry' &&
    pending.choice.kind !== 'discardAny' && pending.choice.kind !== 'exhaustAny'
    ? Math.min(pending.choice.amount, choicePoolSize)
    : 0
  const pendingDef = pending ? faceOf(cardDef(pending.card.defId), pending.card.upgraded) : null
  const handChoiceSatisfied = pending?.choice?.kind === 'scry'
    ? true
    : pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny'
      ? true
    : pending?.choice ? pending.picked.length === choiceNeeded : true
  const revealedChoiceSatisfied = !pending?.choiceCards || pending.choiceConfirmed
  const variableChoiceSatisfied = pending?.choice?.kind !== 'discardAny' && pending?.choice?.kind !== 'exhaustAny' ||
    pending.choiceConfirmed && pending.picked.length >= variableMinimum
  const modeSatisfied = !pendingDef?.modes || pending?.mode !== null
  const energyChoiceSatisfied = pendingDef?.cost !== 'X' || pending?.energySpent !== null
  const choiceSatisfied = handChoiceSatisfied && revealedChoiceSatisfied && variableChoiceSatisfied &&
    modeSatisfied && energyChoiceSatisfied
  const pendingNeedsCardEnemy = pendingDef
    ? cardNeedsEnemy(pendingDef, viewer, false, pending?.energySpent ?? undefined)
    : false
  const pendingEvokeChoice = pendingDef && pending
    ? nextEvokeChoice(pendingDef, viewer, pending.evokeSlots, pending.mode ?? undefined, pending.energySpent ?? 0)
    : null
  const pendingEvokeTarget = pending?.evokeEnemyUids.findIndex((target) => target === undefined) ?? -1
  const pendingEvokeTargetOptions = pendingDef && pending && viewer
    ? evokeTargetProgress(
      pendingDef, state, viewer, pending.evokeSlots, pending.evokeEnemyUids,
      pending.mode ?? undefined, pending.energySpent ?? 0,
    ).options
    : []
  const pendingEvokeTargetUids = new Set(pendingEvokeTargetOptions.map((option) => option.uid))
  const pendingEvokeUsesRows = Boolean(pending && pendingEvokeTarget >= 0 &&
    chosenEvokeOrbs(pendingDef!, viewer, pending.evokeSlots,
      pending.mode ?? undefined, pending.energySpent ?? 0)[pendingEvokeTarget] === 'lightning' &&
    lightningTargetsRows(viewer, pending.card.defId))
  const evokeChoicesDone = pendingEvokeChoice === null && pendingEvokeTarget < 0
  const enemyChoicesDone = pending ? (
    evokeChoicesDone &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.enemyUids.length >= pending.enemyChoices &&
    pending.shivEnemyUids.length >= pending.spentShivs + pending.overflowShivs
  ) : true
  const allyChoiceDone = (!pending?.needsAlly || pending.playerId !== null) &&
    (!pending || pending.playerIds.length >= pending.playerChoices)
  const switchChoiceReady = Boolean(pending?.needsSwitch && !pending.switchChoiceDone &&
    enemyChoicesDone && choiceSatisfied && allyChoiceDone)

  function commit(next: Pending, skipOverflow = false) {
    if (cardActionPending.current) return
    const context = {
      enemyUid: next.enemyUid,
      enemyUids: next.enemyUids,
      playerId: next.playerId ?? viewer!.id,
      energySpent: next.energySpent ?? undefined,
      playerIds: next.playerIds,
      switchWithPlayerId: next.switchChoiceDone ? next.switchPlayerId : null,
      mode: next.mode ?? undefined,
      discardUids: next.choice?.kind === 'discard' || next.choice?.kind === 'discardAny'
        ? next.picked
        : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' || next.choice?.kind === 'exhaustAny'
        ? next.picked
        : undefined,
      scryDiscardUids: next.choice?.kind === 'scry' ? next.picked : undefined,
      topdeckUids: next.choice?.kind === 'topdeck' ? next.picked : undefined,
      recoverDiscardUid: next.choice?.kind === 'recover' ? next.picked[0] : undefined,
      recoverExhaustUid: next.choice?.kind === 'recoverExhaust' ? next.picked[0] : undefined,
      searchDrawUids: next.choice?.kind === 'search' ? next.picked : undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
      evokeSlots: next.evokeSlots,
      evokeEnemyUids: next.evokeEnemyUids as (string | null)[],
    }
    // The online draw pile is redacted. The room has already bound this action
    // to its private preview, so only the authoritative engine can validate it.
    const result = onAction && next.choiceCards
      ? undefined
      : next.cardInHand
        ? playCard(state, viewer!.id, next.card.uid, context)
        : playCardCopy(state, viewer!.id, context)
    if (result === state) {
      if (next.enemyUids.length > 0 || next.playerIds.length > 0 ||
        next.shivEnemyUids.length > 0 || next.evokeSlots.length > 0) {
        setPending({ ...next, enemyUids: [], playerIds: [], shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })
      }
      return
    }
    const action = {
      kind: next.cardInHand ? 'playCard' : 'playCardCopy',
      cardUid: next.card.uid,
      ...context,
      preflight: true,
      expectedShivOverflow: next.overflowShivs > 0 ? next.overflowShivs : undefined,
      skipOverflow: next.overflowShivs > 0 ? skipOverflow : undefined,
    }
    if (onAction) {
      const usingMiracle = miracleOnCard
      cardActionPending.current = true
      setUsingCard(true)
      setMiracleOnCard(false)
      setPending(null)
      const unlock = () => {
        unknownCardAction.current = null
        cardActionPending.current = false
        setUsingCard(false)
      }
      const finish = (outcome: ActionOutcome | void) => {
        if (outcome?.status === 'unknown') {
          const current = stateRef.current.players.find((player) => player.id === viewerId)
          const currentCopy = stateRef.current.pendingCardCopy
          const copiesBefore = next.cardInHand ? undefined : state.pendingCardCopy?.sourceNames.length
          const refreshAttempt = outcome.refreshAttempt ?? refreshRef.current
          const committed = next.cardInHand
            ? current && !current.hand.some((card) => card.uid === next.card.uid)
            : currentCopy?.card.uid !== next.card.uid ||
              (copiesBefore !== undefined && currentCopy.sourceNames.length < copiesBefore)
          if (committed ||
            (refreshAttempt !== undefined && refreshRef.current !== undefined && refreshRef.current > refreshAttempt)) unlock()
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = {
              refreshAttempt,
              cardUid: next.card.uid,
              copy: !next.cardInHand,
              copiesBefore,
            }
          } else unlock()
          return
        }
        unlock()
        if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
          const authoritative = reconciliation(outcome)
          if (!authoritative || (next.cardInHand
            ? !authoritative.player.hand?.some((card) => card.uid === next.card.uid)
            : authoritative.combat.pendingCardCopy?.card.uid !== next.card.uid)) return
          if (next.choiceCards &&
            (next.choice?.kind === 'recover' || next.choice?.kind === 'recoverExhaust')) {
            setMiracleOnCard(usingMiracle)
            const cards = next.choice.kind === 'recover'
              ? authoritative.player.discard
              : authoritative.player.exhaust
            if (cards.length === 0) {
              setPending(null)
              return
            }
            setPending({
              ...next,
              choice: cards.length > 0 ? { kind: next.choice.kind, amount: 1 } : null,
              choiceCards: cards.length > 0 ? cards : null,
              choiceConfirmed: false,
              picked: [],
              enemyUid: null,
            })
            return
          }
          if (next.choiceCards) {
            setMiracleOnCard(usingMiracle)
            if (next.cardInHand) requestChoicePreview(next.card, next.enemyUid)
            else requestCopyChoicePreview(next.enemyUid)
            return
          }
          const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
          const overflowShivs = overflowShivCount(authoritative.combat,
            cardShivsOnPlay(def, next.choice?.kind === 'discardAny' ? next.picked.length : 0))
          const spentShivs = cardShivChoiceCount(def, authoritative.player)
          const enemyChoices = cardEnemyChoiceCount(def)
          const playerChoices = cardPlayerChoiceCount(def)
          const energySpent = next.cardInHand
            ? playCost(def, authoritative.player, next.card) === 'X' ? null : 0
            : authoritative.combat.pendingCardCopy?.energySpent ?? 0
          const needsEnemy = cardNeedsEnemy(def, authoritative.player, false, energySpent ?? undefined) || spentShivs > 0 ||
            overflowShivs > 0 || enemyChoices > 0
          const needsAlly = def.supportTarget === 'anyPlayer' &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          setMiracleOnCard(usingMiracle)
          if (needsEnemy || needsAlly || playerChoices > 0 || needsSwitch || def.modes || next.choice ||
            nextEvokeChoice(def, authoritative.player, [], undefined, energySpent ?? 0)) {
            setPending({
              ...next,
              energySpent,
              needsEnemy,
              needsAlly,
              needsSwitch,
              overflowShivs,
              spentShivs,
              enemyChoices,
              playerChoices,
              enemyUid: null,
              enemyUids: [],
              playerId: null,
              playerIds: authoritative.combat.players.filter((player) => !player.dead).length === 1
                ? Array(playerChoices).fill(authoritative.player.id)
                : [],
              picked: next.picked.filter((uid) =>
                authoritative.player.hand?.some((card) => card.uid === uid) === true),
              choiceConfirmed: overflowShivs === 0 &&
                (next.choice?.kind === 'discardAny' || next.choice?.kind === 'exhaustAny')
                ? false
                : next.choiceConfirmed,
              switchPlayerId: null,
              switchChoiceDone: false,
              shivEnemyUids: [],
              evokeSlots: [],
              evokeEnemyUids: [],
              mode: null,
            })
          }
        }
      }
      Promise.resolve(onAction(action)).then(finish, () => finish({ status: 'unknown' }))
      return
    }
    setMiracleOnCard(false)
    if (result) onChange?.(result)
    setPending(null)
  }

  function stageOrCommit(next: Pending) {
    const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
    const evokeProgress = evokeTargetProgress(
      def, state, viewer!, next.evokeSlots, next.evokeEnemyUids,
      next.mode ?? undefined, next.energySpent ?? 0,
    )
    if (evokeProgress.endedCombat && next.evokeEnemyUids.length > evokeProgress.index) {
      next = { ...next, evokeEnemyUids: next.evokeEnemyUids.slice(0, evokeProgress.index) }
    }
    const overflowShivs = overflowShivCount(state,
      cardShivsOnPlay(def, next.choice?.kind === 'discardAny' ? next.picked.length : 0))
    const spentShivs = cardShivChoiceCount(def, viewer!)
    if (overflowShivs !== next.overflowShivs || spentShivs !== next.spentShivs) {
      next = {
        ...next,
        overflowShivs,
        spentShivs,
        needsEnemy: cardNeedsEnemy(def, viewer!, false) || spentShivs > 0 ||
          overflowShivs > 0 || next.enemyChoices > 0,
        shivEnemyUids: [],
      }
      setPending(next)
    }
    const poolSize = next.choiceCards?.length ?? Math.max(0, viewer!.hand.length - Number(next.cardInHand))
    const minimumPaid = next.picked.length >= Math.min(next.choice?.minimum ?? 0, poolSize)
    const owed = next.choice && next.choice.kind !== 'scry' &&
      next.choice.kind !== 'discardAny' && next.choice.kind !== 'exhaustAny'
      ? Math.min(next.choice.amount, poolSize)
      : 0
    const selectionReady = next.choice?.kind === 'scry' || next.choice?.kind === 'discardAny' ||
      next.choice?.kind === 'exhaustAny' ||
      next.picked.length === owed
    const ready = selectionReady && minimumPaid && (!next.choiceCards || next.choiceConfirmed) &&
      (next.choice?.kind !== 'discardAny' && next.choice?.kind !== 'exhaustAny' || next.choiceConfirmed) &&
      (!def.modes || next.mode !== null) &&
      !nextEvokeChoice(def, viewer!, next.evokeSlots, next.mode ?? undefined, next.energySpent ?? 0) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      (!cardNeedsEnemy(def, viewer!, false, next.energySpent ?? undefined) || next.enemyUid !== null) &&
      next.enemyUids.length >= next.enemyChoices &&
      next.shivEnemyUids.length >= next.spentShivs + next.overflowShivs &&
      next.playerIds.length >= next.playerChoices &&
      (!next.needsAlly || next.playerId !== null) &&
      (!next.needsSwitch || next.switchChoiceDone)
    if (ready) commit(next)
    else setPending(next)
  }

  function requestChoicePreview(card: CardInstance, enemyUid: string | null = null) {
    if (cardActionPending.current) return
    if (!onAction) {
      const preview = previewCardChoice(state, viewer!.id, card.uid)
      if (!preview) return
      const next = { ...pendingFor(card, preview.cards, state, viewer!), enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }

    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({
      kind: 'previewCard', cardUid: card.uid, spendMiracle: miracleOnCard, enemyUid,
    })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const preview = outcome?.snapshot?.cardPreview
      const current = stateRef.current
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const held = player?.hand.find((candidate) => candidate.uid === card.uid)
      if (outcome?.status !== 'accepted' || !preview || preview.cardUid !== card.uid || !player || !held) return
      const next = { ...pendingFor(held, preview.cards, current, player), enemyUid: preview.enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function requestCopyChoicePreview(enemyUid: string | null = null) {
    if (cardActionPending.current || !viewer) return
    const copy = state.pendingCardCopy
    if (!copy || copy.playerId !== viewer.id) return
    if (!onAction) {
      const preview = previewCardCopyChoice(state, viewer.id)
      if (!preview) return
      const next = { ...pendingFor(copy.card, preview.cards, state, viewer, false, copy.energySpent), enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
      return
    }
    cardActionPending.current = true
    setUsingCard(true)
    Promise.resolve(onAction({ kind: 'previewCardCopy', cardUid: copy.card.uid, enemyUid })).then((outcome) => {
      cardActionPending.current = false
      setUsingCard(false)
      const current = stateRef.current
      const currentCopy = current.pendingCardCopy
      const player = current.players.find((candidate) => candidate.id === viewerId)
      const preview = outcome?.snapshot?.cardPreview
      if (outcome?.status !== 'accepted' || !preview?.copy || !currentCopy || !player) return
      const next = { ...pendingFor(currentCopy.card, preview.cards, current, player, false,
        currentCopy.energySpent), enemyUid: preview.enemyUid }
      if (next.choice?.kind === preview.kind) setPending(next)
    }, () => {
      cardActionPending.current = false
      setUsingCard(false)
    })
  }

  function onCardClick(card: CardInstance) {
    if (cardActionPending.current || orderingStage || pendingTrigger) return
    setPendingPowerUid(null)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    // While a card is waiting on a choice, clicks in hand pick cards for it.
    if (pending?.choice && !pending.choiceCards && card.uid !== pending.card.uid) {
      const already = pending.picked.includes(card.uid)
      const any = pending.choice.kind === 'discardAny' || pending.choice.kind === 'exhaustAny'
      const handChoices = Math.max(0, viewer!.hand.length - Number(pending.cardInHand))
      const need = pending.choice.kind === 'discardAny'
        ? handChoices
        : Math.min(pending.choice.amount, handChoices)
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-need)
      const next = { ...pending, picked, choiceConfirmed: false }
      setPending(next)
      // True Grit exhausts a card AND blocks any player, so satisfying the
      // choice must not skip the ally step.
      if (!any && !next.needsEnemy && !next.needsAlly &&
        next.playerIds.length >= next.playerChoices && !next.needsSwitch && picked.length === need) {
        stageOrCommit(next)
      }
      return
    }

    // A normal staged card can be cancelled. A card that already revealed
    // hidden information is committed and must be finished.
    if (pending?.card.uid === card.uid) {
      if (pending.choiceCards && pending.choice?.kind !== 'recover' &&
        pending.choice?.kind !== 'recoverExhaust') return
      setPending(null)
      return
    }

    if (pending?.choiceCards) return

    const def = faceOf(cardDef(card.defId), card.upgraded)
    if (cardNeedsChoicePreview(def, state, viewer!)) {
      if (cardNeedsEnemy(def, viewer!, false)) {
        const next = pendingFor(card, null, state, viewer!)
        setPending({ ...next, choice: null })
        return
      }
      requestChoicePreview(card)
      return
    }
    const next = pendingFor(card, null, state, viewer!)
    setPending(next)
    // Only resolve on the spot when there is genuinely nothing left to pick —
    // including a cost the hand is too small to pay anything towards.
    const owed = next.choice && next.choice.kind !== 'discardAny' && next.choice.kind !== 'exhaustAny'
      ? Math.min(next.choice.amount, next.choiceCards?.length ??
        Math.max(0, viewer!.hand.length - Number(next.cardInHand)))
      : 0
    if (next.choice?.kind !== 'discardAny' && next.choice?.kind !== 'exhaustAny' &&
      !next.needsEnemy && !next.needsAlly &&
      next.playerIds.length >= next.playerChoices && !next.needsSwitch && owed === 0 &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      !def.modes && !nextEvokeChoice(def, viewer!, next.evokeSlots, undefined, next.energySpent ?? 0)) commit(next)
  }

  function onChoiceCardClick(card: CardInstance) {
    if (!pending?.choiceCards || !pending.choice) return
    const already = pending.picked.includes(card.uid)
    const picked = already
      ? pending.picked.filter((uid) => uid !== card.uid)
      : pending.choice.kind === 'scry'
        ? [...pending.picked, card.uid]
        : [...pending.picked, card.uid].slice(-choiceNeeded)
    setPending({ ...pending, picked, choiceConfirmed: false })
  }

  function confirmChoice() {
    if (!pending?.choiceCards || !handChoiceSatisfied) return
    stageOrCommit({ ...pending, choiceConfirmed: true })
  }

  function onEnemyClick(enemy: Enemy) {
    if (pendingTrigger && pendingTrigger.playerId === viewer?.id &&
      pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) {
      resolveTrigger(undefined, enemy.uid)
      return
    }
    if (pendingStartEnemy) {
      chooseStartTurnEnemy(enemy.uid)
      return
    }
    if (pendingStartShiv) {
      chooseStartTurnShiv(enemy.uid)
      return
    }
    if (pendingStartEvokeTarget) {
      if (pendingStartEvokeRows.length > 0) return
      chooseStartTurnEvokeEnemy(enemy.uid)
      return
    }
    if (pendingPotion) {
      if (pendingPotionDef?.target === 'enemy') {
        consumePotion(pendingPotion, { enemyUid: enemy.uid })
      } else if (!pendingPotionDef?.target && potionShivEnemyUids.length < pendingPotionOverflow) {
        const next = [...potionShivEnemyUids, enemy.uid]
        if (next.length === pendingPotionOverflow) {
          consumePotion(
            pendingPotion,
            { shivEnemyUids: next },
            { expected: pendingPotionOverflow, skip: false },
          )
        } else setPotionShivEnemyUids(next)
      }
      return
    }
    if (pendingPowerUid && pendingPowerDef && pendingPowerDef.target !== 'row') {
      usePower(pendingPowerUid, { enemyUid: enemy.uid })
      return
    }
    if (spendingShiv) {
      if (onAction) {
        setSpendingShiv(false)
        onAction({ kind: 'spendShiv', enemyUid: enemy.uid })
        return
      }
      const result = spendShiv(state, viewer!.id, enemy.uid)
      if (result !== state) {
        setSpendingShiv(false)
        onChange?.(result)
      }
      return
    }
    if (pending && pendingEvokeTarget >= 0 && choiceSatisfied) {
      if (pendingEvokeUsesRows) return
      if (!pendingEvokeTargetUids.has(enemy.uid)) return
      const targets = [...pending.evokeEnemyUids]
      targets[pendingEvokeTarget] = enemy.uid
      stageOrCommit({ ...pending, evokeEnemyUids: targets })
      return
    }
    if (!evokeChoicesDone) return
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    const normalTargetNeeded = pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
      if (pendingDef && cardNeedsChoicePreview(pendingDef, state, viewer!)) {
        if (pending.cardInHand) requestChoicePreview(pending.card, enemy.uid)
        else requestCopyChoicePreview(enemy.uid)
        return
      }
      const next = { ...pending, enemyUid: enemy.uid }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.enemyUids.length < pending.enemyChoices) {
      const next = { ...pending, enemyUids: [...pending.enemyUids, enemy.uid] }
      if (next.enemyUids.length < next.enemyChoices || next.spentShivs + next.overflowShivs > 0 ||
        next.needsAlly || next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs) {
      const next = { ...pending, shivEnemyUids: [...pending.shivEnemyUids, enemy.uid] }
      if (next.shivEnemyUids.length < next.spentShivs + next.overflowShivs || next.needsAlly ||
        next.playerIds.length < next.playerChoices || next.needsSwitch) setPending(next)
      else commit(next)
    }
  }

  function onEvokeClick(slot: number) {
    if (!pending || !pendingEvokeChoice || pendingEvokeTarget >= 0 || !choiceSatisfied) return
    const option = pendingEvokeChoice.options.find((candidate) => candidate.slot === slot)
    if (!option) return
    const evokeSlots = [...pending.evokeSlots, slot]
    const orbs = chosenEvokeOrbs(pendingDef!, viewer!, evokeSlots,
      pending.mode ?? undefined, pending.energySpent ?? 0)
    stageOrCommit({
      ...pending,
      evokeSlots,
      evokeEnemyUids: [...pending.evokeEnemyUids, ...orbs.slice(pending.evokeEnemyUids.length)
        .map((orb) => orb === 'frost' ? null : undefined)],
    })
  }

  function onModeClick(mode: number) {
    if (!pending || !pendingDef?.modes?.[mode]) return
    stageOrCommit({ ...pending, mode })
  }

  function onAllyClick(ally: Player) {
    if (ally.dead) return
    if (pendingPotion && potionDef(pendingPotion).supportTarget === 'anyPlayer') {
      consumePotion(pendingPotion, { targetPlayerId: ally.id })
      return
    }
    if (!pending || !enemyChoicesDone || !choiceSatisfied) return
    if (pending.playerIds.length < pending.playerChoices) {
      const next = { ...pending, playerIds: [...pending.playerIds, ally.id] }
      if (next.playerIds.length < next.playerChoices || next.needsAlly || next.needsSwitch) setPending(next)
      else commit(next)
      return
    }
    if (pending.needsAlly && pending.playerId === null) {
      stageOrCommit({ ...pending, playerId: ally.id })
      return
    }
    if (switchChoiceReady && ally.id !== viewerId) {
      stageOrCommit({ ...pending, switchPlayerId: ally.id, switchChoiceDone: true })
    }
  }

  // Ordered by what the player must do NEXT: an unsatisfied choice first, then
  // whatever target is still outstanding. Showing the choice text after it is
  // satisfied would leave the player stuck looking at a completed instruction.
  const spentShivPending = Boolean(pending && pending.shivEnemyUids.length < pending.spentShivs)
  const normalEnemyPending = Boolean(pendingNeedsCardEnemy && !pending?.enemyUid)
  const overflowOnly = Boolean(pending && !spentShivPending && pending.overflowShivs > 0 &&
    pending.shivEnemyUids.length < pending.spentShivs + pending.overflowShivs &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.enemyUids.length >= pending.enemyChoices)
  const independentEnemyPending = Boolean(pending && pending.enemyUids.length < pending.enemyChoices)
  const independentPlayerPending = Boolean(pending && pending.playerIds.length < pending.playerChoices)
  const copySource = pending?.cardInHand !== false && pendingDef?.id !== 'burst'
    ? (pendingDef?.type === 'attack' || pendingDef?.type === 'skill') && (viewer.doubledCardsThisTurn ?? 0) > 0
      ? 'Echo Form'
      : pendingDef?.type === 'attack' && (viewer.doubledAttacksThisTurn ?? 0) > 0
        ? 'Double Tap'
        : pendingDef?.type === 'skill' && (viewer.doubledSkillsThisTurn ?? 0) > 0 ? 'Burst' : null
    : null
  const copyTarget = copySource ? ` for ${pendingDef?.name ?? 'card'} copy (${copySource})` : ''
  const originalTarget = pending?.cardInHand === false
    ? ` for original ${pendingDef?.name ?? 'card'} after ${state.pendingCardCopy?.sourceNames[0] ?? 'its'} copy`
    : ''
  const normalEnemyPrompt = pending?.hitsRow
    ? state.enemies.some((enemy) => enemy.isBoss && !enemy.dead)
      ? `Choose an enemy${originalTarget || copyTarget} — its whole row is hit, and the boss`
      : `Choose an enemy${originalTarget || copyTarget} — its whole row is hit`
    : `Choose an enemy${originalTarget || copyTarget}`
  const enemyPrompt = normalEnemyPending
    ? normalEnemyPrompt
    : independentEnemyPending
      ? `Choose token target ${(pending?.enemyUids.length ?? 0) + 1}/${pending?.enemyChoices}`
    : spentShivPending
      ? `Choose Shiv attack ${(pending?.shivEnemyUids.length ?? 0) + 1}/${pending?.spentShivs}`
    : overflowOnly
    ? `Choose overflow Shiv target ${(pending?.shivEnemyUids.length ?? 0) - (pending?.spentShivs ?? 0) + 1}/${pending?.overflowShivs}, or skip the rest`
    : normalEnemyPrompt
  const startTurnPrompt = pendingStartShiv
    ? `${pendingStartShiv.ability.label} — choose overflow Shiv ${pendingStartShiv.index + 1}/${pendingStartShiv.ability.overflowShivs}, or skip`
    : pendingStartEnemy
      ? `${pendingStartEnemy.label} — choose an enemy`
    : pendingStartEvokeTarget
      ? `${pendingStartEvokeTarget.ability.label} — choose a ${pendingStartEvokeRows.length > 0 ? 'row' : 'target'} for the Evoked Orb`
    : pendingStartEvoke?.evokeChoice
      ? `${pendingStartEvoke.label} — choose an Orb to Evoke`
    : null
  const forcedPrompt = forcedCard && !pending
    ? forcedCard.playerId === viewerId
      ? `${cardDef(forcedCard.sourceCardId ?? 'mayhem').name} — play the drawn card for 0 Energy`
      : `Waiting for ${state.players.find((player) => player.id === forcedCard.playerId)?.name ?? 'another player'} to play ${cardDef(forcedCard.sourceCardId ?? 'mayhem').name}'s card`
    : null
  const triggerPrompt = pendingTrigger
    ? pendingTrigger.playerId === viewer.id
      ? `${pendingTrigger.label} — choose ${pendingTrigger.targets ? 'an enemy' : 'a row'}`
      : `Waiting for ${state.players.find((player) => player.id === pendingTrigger.playerId)?.name ?? 'another player'} to resolve ${pendingTrigger.label}`
    : null
  const beforeDrawPrompt = activeStartTurnScry && activeStartTurnScry.playerId !== viewer.id
    ? `Waiting for ${state.players.find((player) => player.id === activeStartTurnScry.playerId)?.name ?? 'another player'} to Scry before drawing`
    : null
  const prompt = triggerPrompt ?? forcedPrompt ?? beforeDrawPrompt ?? startTurnPrompt ?? (pendingPowerDef
    ? `Choose ${pendingPowerDef.target === 'row' ? 'a row' : 'an enemy'} for ${pendingPowerDef.name}`
    : pendingPotionDef
    ? pendingPotionDef.target === 'row'
      ? `Choose a row for ${pendingPotionDef.name}`
      : pendingPotionOverflow > 0
        ? `Choose overflow Shiv target ${potionShivEnemyUids.length + 1}/${pendingPotionOverflow}, or skip the rest`
        : `Choose ${pendingPotionDef.target ? 'an enemy' : 'a player'} for ${pendingPotionDef.name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : pendingDef?.cost === 'X' && pending?.energySpent === null
      ? `Choose Energy for ${pendingDef.name}`
    : pendingDef?.modes && !modeSatisfied
      ? `Choose how to play ${pendingDef.name}`
    : pending?.choiceCards && !pending.choiceConfirmed
      ? pending.choice?.kind === 'scry'
        ? `Scry ${pending.choice.amount} — choose any cards to discard`
        : pending.choice?.kind === 'topdeck'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} card to put on top`
        : pending.choice?.kind === 'recover'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your discard pile`
        : pending.choice?.kind === 'recoverExhaust'
          ? `${pendingDef?.name ?? 'Card'} — choose a card from your Exhaust pile`
        : pending.choice?.kind === 'search'
          ? `${pendingDef?.name ?? 'Card'} — choose ${choiceNeeded} from your draw pile`
        : `Discard ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} after drawing`
    : (pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny') && !pending.choiceConfirmed
      ? pending.choice.kind === 'discardAny'
        ? `Discard any number of cards — ${pending.picked.length} chosen`
        : `Exhaust ${pending.choice.minimum ? `${pending.choice.minimum}-${pending.choice.amount}` : `up to ${pending.choice.amount}`} cards — ${pending.picked.length} chosen`
    : pending?.choice && !handChoiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
      : pendingEvokeTarget >= 0
        ? `Choose ${pendingEvokeUsesRows ? 'a row' : 'an enemy'} for this evoke`
        : pendingEvokeChoice
          ? `Choose Orb to evoke ${pendingEvokeChoice.index + 1}`
        : pending?.needsEnemy && !enemyChoicesDone
        ? enemyPrompt
        : independentPlayerPending
          ? `Choose Block recipient ${(pending?.playerIds.length ?? 0) + 1}/${pending?.playerChoices}`
        : pending?.needsAlly && !pending.playerId
          ? 'Choose who gets it'
          : switchChoiceReady
            ? 'Choose another player to switch rows with, or keep rows'
          : null)

  return (
    <div className="combat" data-phase={state.phase}>
      <header className="combat__bar">
        <span className="combat__turn">Turn {state.turn}</span>
        <span className="combat__die" title="The round's shared die">
          <Icon name={dieIcon(state.die)} size={26} decorative={false} />
        </span>
        <span className={`combat__phase combat__phase--${state.phase}`}>{state.phase === 'copy'
          ? `Resolve original ${pendingDef?.name ?? 'card'}`
          : PHASE_LABEL[state.phase]}</span>
        <span className="combat__actions">
          {!viewer.dead && (state.phase === 'player' || state.phase === 'discard') ? (
            <>
              {state.phase === 'player' && !forcedCard && !orderingStage && !pendingTrigger ? viewer.powers.flatMap((power) => {
                const def = faceOf(cardDef(power.defId), power.upgraded)
                if (!def.activeAbility) return []
                const staged = pendingPowerUid === power.uid
                const used = powerAbilityUsed(state, viewer.id, power.uid)
                return [<button
                  type="button"
                  key={power.uid}
                  disabled={usingPower || used || Boolean(pending?.choiceCards)}
                  aria-pressed={staged}
                  onClick={() => {
                    setPending(null)
                    setSpendingShiv(false)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setPendingPowerUid(staged ? null : power.uid)
                  }}
                >{used ? `${def.name} used` : `${staged ? '✓ ' : ''}Use ${def.name}`}</button>]
              }) : null}
              {state.phase === 'player' && !forcedCard && !orderingStage && !pendingTrigger ? [...new Set(viewer.potions)].map((potionId) => {
                const potion = potionDef(potionId)
                const staged = pendingPotion === potionId
                const count = viewer.potions.filter((held) => held === potionId).length
                const shivs = gainedShivs(potion.effects)
                const needsTarget = Boolean(potion.target) || (
                  potion.supportTarget === 'anyPlayer' && livingPlayers.length > 1
                ) || overflowShivCount(state, shivs) > 0
                return (
                  <button
                    type="button"
                    key={potionId}
                    disabled={usingPotion || Boolean(pending?.choiceCards)}
                    aria-pressed={needsTarget ? staged : undefined}
                    title={potion.text}
                    onClick={() => {
                      if (needsTarget) {
                        setPending(null)
                        setPendingPowerUid(null)
                        setSpendingShiv(false)
                        setMiracleOnCard(false)
                        setPendingPotion(staged ? null : potionId)
                        setPotionShivEnemyUids([])
                        setPotionOverflowRequired(staged ? 0 : overflowShivCount(state, shivs))
                      } else consumePotion(potionId)
                    }}
                  >
                    <Icon name="potion" size={16} /> {staged ? '✓ ' : ''}{potion.name}{count > 1 ? ` ×${count}` : ''}
                  </button>
                )
              }) : null}
              {state.phase === 'player' && !forcedCard && !orderingStage && !pendingTrigger && viewer.shivs > 0 ? (
                <button
                  type="button"
                  disabled={Boolean(pending?.choiceCards)}
                  aria-pressed={spendingShiv}
                  onClick={() => {
                    setPending(null)
                    setPendingPowerUid(null)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setPotionShivEnemyUids([])
                    setPotionOverflowRequired(0)
                    setSpendingShiv((current) => !current)
                  }}
                >
                  {spendingShiv ? '✓ ' : ''}Use Shiv
                </button>
              ) : null}
              {state.phase === 'player' && !forcedCard && !orderingStage && !pendingTrigger && viewer.miracles > 0 ? (
                <button
                  type="button"
                  disabled={Boolean(pending?.choiceCards)}
                  aria-pressed={viewer.energy === CAPS.energy ? miracleOnCard : undefined}
                  onClick={() => {
                    if (viewer.energy < CAPS.energy) {
                      if (onAction) onAction({ kind: 'spendMiracle' })
                      else onChange?.(spendMiracle(state, viewer.id))
                    }
                    else {
                      setPending(null)
                      setPendingPowerUid(null)
                      setSpendingShiv(false)
                      setPendingPotion(null)
                      setPotionShivEnemyUids([])
                      setPotionOverflowRequired(0)
                      setMiracleOnCard((current) => !current)
                    }
                  }}
                >
                  {viewer.energy === CAPS.energy
                    ? `${miracleOnCard ? '✓ ' : ''}Use Miracle on next card`
                    : 'Use Miracle (+1 Energy)'}
                </button>
              ) : null}
              {state.phase === 'discard' && retainAllowance > 0 && discardableHand.length > 0 ? (
                <span className="retain-options" role="group"
                  aria-label={`Retain up to ${retainAllowance} cards for ${viewer.name}`}>
                  {discardableHand.map((card) => {
                    const retained = retainedSet.has(card.uid)
                    const name = faceOf(cardDef(card.defId), card.upgraded).name
                    return <button key={card.uid} type="button" aria-pressed={retained}
                      disabled={!retained && viewerRetainedCards.length >= retainAllowance}
                      onClick={() => setRetainedCards((current) => ({
                        ...current,
                        [viewer.id]: retained
                          ? viewerRetainedCards.filter((uid) => uid !== card.uid)
                          : [...viewerRetainedCards, card.uid],
                      }))}>
                      {retained ? '✓ ' : ''}Retain {name}
                    </button>
                  })}
                </span>
              ) : null}
              {state.phase === 'discard' && discardCandidates.length > 1 ? (
                <label className="discard-order">
                  Top discard
                  <select
                    aria-label={`Top discard for ${viewer.name}`}
                    value={viewerDiscardTop}
                    onChange={(event) => setDiscardTops((current) => ({
                      ...current,
                      [viewer.id]: event.target.value,
                    }))}
                  >
                    {discardCandidates.map((card) => {
                      const def = faceOf(cardDef(card.defId), card.upgraded)
                      return <option key={card.uid} value={card.uid}>{`${def.unplayable ? '—' : cardCost(def, viewer.powers, viewer.lostHpThisCombat)} · ${def.name}`}</option>
                    })}
                  </select>
                </label>
              ) : null}
              {state.phase === 'player' && !forcedCard && (abilities.length > 1 ||
                abilities.some((ability) => (ability.targets?.length ?? 0) > 1)) ? (
                <details className="end-turn-order">
                  <summary>End-turn order ({abilities.length})</summary>
                  <ol>
                    {viewerEndTurnOrder.map((choice, index) => {
                      const ability = abilities.find((candidate) => candidate.id === endTurnChoiceId(choice))!
                      return (
                        <li key={ability.id}>
                          <span>{ability.label}</span>
                          {ability.targets ? (
                            <select aria-label={`Target for ${ability.label}`}
                              disabled={!canOrderEndTurn}
                              value={endTurnChoiceTarget(choice) ?? ability.targets[0]?.uid}
                              onChange={(event) => targetEndTurnAbility(choice, event.target.value)}>
                              {ability.targets.map((target) => (
                                <option key={target.uid} value={target.uid}>{target.label}</option>
                              ))}
                            </select>
                          ) : null}
                          <button type="button" disabled={!canOrderEndTurn || index === 0}
                            aria-label={`Move ${ability.label} earlier`}
                            onClick={() => moveEndTurnAbility(choice, -1)}>↑</button>
                          <button type="button" disabled={!canOrderEndTurn || index === viewerEndTurnOrder.length - 1}
                            aria-label={`Move ${ability.label} later`}
                            onClick={() => moveEndTurnAbility(choice, 1)}>↓</button>
                        </li>
                      )
                    })}
                  </ol>
                </details>
              ) : null}
              {endTurnError ? <span className="combat-error" role="alert">{endTurnError}</span> : null}
              {!forcedCard ? <button type="button" onClick={finishTurn}
                disabled={Boolean(pending?.choiceCards) || Boolean(pendingTrigger) ||
                  (orderingStage && viewer.id !== endTurnCoordinatorId)}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
                  : orderingStage
                    ? viewer.id === endTurnCoordinatorId ? 'Resolve end turn' : 'Waiting for end-turn order'
                    : 'End turn'}
              </button> : null}
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length > 0 ? (
            <>
              <details className="end-turn-order" open>
                <summary>Before-draw Scry order ({orderedStartTurnScries.length})</summary>
                <ol>
                  {orderedStartTurnScries.map((ability, index) => (
                    <li key={ability.id}>
                      <span>{ability.label} — Scry {ability.amount}</span>
                      <button type="button" disabled={!canResolveStartTurn || index === 0}
                        aria-label={`Move ${ability.label} earlier`}
                        onClick={() => moveStartTurnScry(ability.id, -1)}>↑</button>
                      <button type="button" disabled={!canResolveStartTurn || index === orderedStartTurnScries.length - 1}
                        aria-label={`Move ${ability.label} later`}
                        onClick={() => moveStartTurnScry(ability.id, 1)}>↓</button>
                    </li>
                  ))}
                </ol>
              </details>
              <button type="button" disabled={!canResolveStartTurn} onClick={finishStartTurnScryOrder}>
                {canResolveStartTurn ? 'Confirm before-draw order' : 'Waiting for before-draw order'}
              </button>
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length === 0 ? (
            <>
              <details className="end-turn-order">
                <summary>Start-of-turn order ({orderedStartAbilities.length})</summary>
                <ol>
                  {orderedStartAbilities.map((ability, index) => {
                    const targetChosen = ability.targets
                      ? startTurnEnemyTargets[ability.id] !== undefined
                      : false
                    const decided = (startTurnTargets[ability.id] ?? [])
                      .filter((target) => target !== undefined).length
                    const evoked = startTurnEvokeSlots[ability.id]?.length ?? 0
                    return (
                      <li key={ability.id}>
                        <span>{ability.label}{ability.targets
                          ? ` — target ${targetChosen ? 1 : 0}/1`
                          : ''}{ability.overflowShivs > 0
                          ? ` — overflow ${decided}/${ability.overflowShivs}`
                          : ''}{evoked > 0 || ability.evokeChoice
                          ? ` — Evoke ${evoked}${ability.evokeChoice ? '+' : ''}`
                          : ''}</span>
                        <button type="button" disabled={!canResolveStartTurn || index === 0}
                          aria-label={`Move ${ability.label} earlier`}
                          onClick={() => moveStartTurnAbility(ability.id, -1)}>↑</button>
                        <button type="button" disabled={!canResolveStartTurn || index === orderedStartAbilities.length - 1}
                          aria-label={`Move ${ability.label} later`}
                          onClick={() => moveStartTurnAbility(ability.id, 1)}>↓</button>
                      </li>
                    )
                  })}
                </ol>
              </details>
              {orderedStartAbilities.some((ability) =>
                (ability.targets?.length ?? 0) > 1 && startTurnEnemyTargets[ability.id] !== undefined) ||
                Object.values(startTurnTargets).some((targets) =>
                  targets.some((target) => target !== undefined)) ||
                Object.values(startTurnEvokeSlots).some((slots) => slots.length > 0) ? (
                <button type="button" disabled={!canResolveStartTurn}
                  onClick={() => {
                    setStartTurnEnemyTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined,
                    ])))
                    setStartTurnTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      Array(ability.overflowShivs).fill(undefined),
                    ])))
                    setStartTurnEvokeSlots(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                    setStartTurnEvokeTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [ability.id, []])))
                  }}>
                  Reset start choices
                </button>
              ) : null}
              <button type="button" onClick={finishStartTurn}
                disabled={!startTurnReady || !canResolveStartTurn}>
                {canResolveStartTurn ? 'Resolve start of turn' : 'Waiting for start-turn order'}
              </button>
            </>
          ) : null}
          {state.phase === 'enemy' ? (
            <button
              type="button"
              onClick={() => onAction ? onAction({ kind: 'resolveEnemies' }) : onChange?.(enemyTurn(state))}
            >
              Resolve enemies
            </button>
          ) : null}
          {/* The round has ended and the board is holding still so everyone can
              read what the enemies did. This is the only way into the next
              round; without it the combat simply stops after round one. */}
          {state.phase === 'roundEnd' ? (
            <button
              type="button"
              onClick={beginNextTurn}
            >
              Start turn {state.turn + 1}
            </button>
          ) : null}
        </span>
      </header>

      {over ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      {prompt ? (
        <p className="prompt" role="status">
          {prompt}
          {pendingStartShiv && canResolveStartTurn ? (
            <button type="button" className="prompt__cancel" onClick={() => chooseStartTurnShiv(null)}>
              Skip this Shiv
            </button>
          ) : null}
          {pendingStartEvoke?.evokeChoice && !pendingStartEvokeTarget
            ? pendingStartEvoke.evokeChoice.options.map((option) => (
              <button type="button" className="prompt__orb" key={option.slot}
                onClick={() => chooseStartTurnEvoke(option.slot)}>
                <span className={`token token--orb token--orb-${option.orb}`} />
                {option.orb} slot {option.slot + 1}
              </button>
            ))
            : null}
          {pending && overflowOnly && choiceSatisfied ? (
            <button type="button" className="prompt__cancel" onClick={() => commit(pending, true)}>
              Skip remaining overflow attacks
            </button>
          ) : null}
          {pendingDef?.cost === 'X' && pending?.energySpent === null
            ? Array.from({ length: viewer.energy - (pendingDef.minimumX ?? 0) + 1 }, (_, at) => {
              const energy = at + (pendingDef.minimumX ?? 0)
              return (
                <button type="button" className="prompt__mode" key={energy}
                  onClick={() => stageOrCommit({ ...pending, energySpent: energy })}>
                  Spend {energy}
                </button>
              )
            })
            : null}
          {(pending?.choice?.kind === 'discardAny' || pending?.choice?.kind === 'exhaustAny') && !pending.choiceConfirmed ? (
            <button type="button" className="prompt__mode"
              disabled={pending.picked.length < variableMinimum}
              onClick={() => stageOrCommit({ ...pending, choiceConfirmed: true })}>
              {pending.picked.length === 0
                ? `${pending.choice.kind === 'discardAny' ? 'Discard' : 'Exhaust'} none`
                : `${pending.choice.kind === 'discardAny' ? 'Discard' : 'Exhaust'} ${pending.picked.length}`}
            </button>
          ) : null}
          {pendingEvokeChoice && pendingEvokeTarget < 0 ? pendingEvokeChoice.options.map((option) => (
            <button type="button" className="prompt__orb" key={option.slot}
              onClick={() => onEvokeClick(option.slot)}>
              <span className={`token token--orb token--orb-${option.orb}`} />
              {option.orb} slot {option.slot + 1}
            </button>
          )) : null}
          {pendingDef?.modes && !modeSatisfied ? pendingDef.modes.map((mode, index) => (
            <button type="button" className="prompt__mode" key={mode.label}
              onClick={() => onModeClick(index)}>
              {mode.label}
            </button>
          )) : null}
          {pendingPotion && pendingPotionOverflow > 0 ? (
            <button
              type="button"
              className="prompt__cancel"
              onClick={() => consumePotion(
                pendingPotion,
                { shivEnemyUids: potionShivEnemyUids },
                { expected: pendingPotionOverflow, skip: true },
              )}
            >
              Skip remaining overflow attacks
            </button>
          ) : null}
          {pending && switchChoiceReady ? (
            <button type="button" className="prompt__cancel"
              onClick={() => stageOrCommit({ ...pending, switchPlayerId: null, switchChoiceDone: true })}>
              Keep rows
            </button>
          ) : null}
          {!pendingTrigger && !pendingStartEnemy && !pendingStartShiv && !pendingStartEvokeTarget && !pendingStartEvoke &&
            (!pending?.choiceCards ||
              (pending.choice?.kind === 'recover' || pending.choice?.kind === 'recoverExhaust') &&
              pending.choiceConfirmed) &&
            !forcedCard ? <button
            hidden={pending?.cardInHand === false}
            type="button"
            className="prompt__cancel"
            onClick={() => {
              setPending(null)
              setPendingPowerUid(null)
              setSpendingShiv(false)
              setPendingPotion(null)
              setPotionShivEnemyUids([])
              setPotionOverflowRequired(0)
            }}
          >
            Cancel
          </button> : null}
        </p>
      ) : null}

      {activeStartTurnScry?.playerId === viewerId && activeStartTurnScry.cards ? (
        <dialog ref={startTurnScryDialogRef} className="choice-modal" aria-labelledby="start-turn-scry-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-scry-title">Foresight — Scry {activeStartTurnScry.amount}</h2>
            <p>Select any revealed cards to discard; unselected cards stay on top in order.</p>
            <div className="choice-modal__cards">
              {activeStartTurnScry.cards.map((card) => (
                <Card key={card.uid} card={card} selected={startTurnScryPicked.includes(card.uid)}
                  onClick={chooseStartTurnScryCard} />
              ))}
              {activeStartTurnScry.cards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={resolvingStartTurnScry} onClick={() => void finishStartTurnScry()}>
              {startTurnScryPicked.length === 0
                ? 'Keep all and continue'
                : `Discard ${startTurnScryPicked.length} and continue`}
            </button>
          </div>
        </dialog>
      ) : null}

      {pending?.choiceCards && pending.choice && !pending.choiceConfirmed ? (
        <dialog ref={choiceDialogRef} className="choice-modal" aria-labelledby="choice-modal-title"
          onCancel={(event) => {
            event.preventDefault()
            if (pending.cardInHand &&
              (pending.choice?.kind === 'recover' || pending.choice?.kind === 'recoverExhaust')) setPending(null)
          }}>
          <div className="choice-modal__panel">
            <h2 id="choice-modal-title">
              {pending.choice.kind === 'scry'
                ? `Scry ${pending.choice.amount}`
                : pending.choice.kind === 'topdeck'
                  ? `Choose ${choiceNeeded} for the top of your draw pile`
                : pending.choice.kind === 'recover'
                  ? 'Choose a card from your discard pile'
                : pending.choice.kind === 'recoverExhaust'
                  ? 'Choose a card from your Exhaust pile'
                : pending.choice.kind === 'search'
                  ? `Choose ${choiceNeeded} from your draw pile`
                  : `Choose ${choiceNeeded} to discard`}
            </h2>
            <p>
              {pending.choice.kind === 'scry'
                ? 'Select any revealed cards to discard; unselected cards stay on top in order.'
                : pending.choice.kind === 'topdeck'
                  ? `${pending.picked.length}/${choiceNeeded} selected. The card is committed.`
                : pending.choice.kind === 'recover'
                  ? `${pending.picked.length}/${choiceNeeded} selected from discard.`
                : pending.choice.kind === 'recoverExhaust'
                  ? `${pending.picked.length}/${choiceNeeded} selected from Exhaust.`
                : pending.choice.kind === 'search'
                  ? `${pending.picked.length}/${choiceNeeded} selected; the rest will be shuffled.`
                : `${pending.picked.length}/${choiceNeeded} selected.${pending.picked.length > 0
                  ? ` Discard order (later is higher): ${pending.picked.map((uid, index) => {
                    const card = pending.choiceCards!.find((held) => held.uid === uid)!
                    return `${index + 1}. ${faceOf(cardDef(card.defId), card.upgraded).name}`
                  }).join(' → ')}.`
                  : ''} The card is committed.`}
            </p>
            <div className="choice-modal__cards">
              {pending.choiceCards.map((card) => (
                <Card key={card.uid} card={card} selected={pending.picked.includes(card.uid)}
                  onClick={onChoiceCardClick} />
              ))}
              {pending.choiceCards.length === 0 ? <span className="muted">No cards were revealed.</span> : null}
            </div>
            <button type="button" disabled={!handChoiceSatisfied} onClick={confirmChoice}>
              {pending.choice.kind === 'scry'
                ? pending.picked.length === 0 ? 'Keep all' : `Discard ${pending.picked.length} and continue`
                : pending.choice.kind === 'topdeck'
                  ? `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recover'
                  ? pendingDef?.effects.some((effect) => effect.kind === 'recoverDiscard' && effect.toHand)
                    ? 'Return selected card to hand'
                    : 'Put selected card on top'
                : pending.choice.kind === 'recoverExhaust'
                  ? 'Return selected card to hand'
                : pending.choice.kind === 'search'
                  ? `Put selected card${choiceNeeded === 1 ? '' : 's'} in hand and shuffle`
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
            {pending.cardInHand &&
            (pending.choice.kind === 'recover' || pending.choice.kind === 'recoverExhaust') ? (
              <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>Cancel</button>
            ) : null}
          </div>
        </dialog>
      ) : null}

      <div className="board" data-rows={rows.length} ref={boardRef} tabIndex={0} aria-label="Combat board">
        {bosses.length > 0 ? (
          <div className="board__bosses">
            {bosses.map((enemy) => (
              <EnemyCard
                key={enemy.uid}
                enemy={enemy}
                label={enemyLabel(state.enemies, enemy)}
                die={state.die}
                struck={struck.has(enemy.uid)}
                beat={beat}
                targeted={(isStartTurnEnemyTarget(enemy.uid) ||
                  (pendingTrigger?.playerId === viewer.id &&
                    pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) ||
                  ((pendingPotionDef?.target === 'enemy' || (pendingPowerDef && pendingPowerDef.target !== 'row') || pendingPotionOverflow > 0) || spendingShiv || (
                  ((pendingEvokeTarget < 0 && pending?.needsEnemy === true && !enemyChoicesDone) ||
                    (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
                ))) && !enemy.dead}
                onClick={onEnemyClick}
              />
            ))}
          </div>
        ) : null}

        {rows.map((row) => {
          const occupant = state.players.find((player) => player.row === row)
          const foes = state.enemies.filter((enemy) => enemy.row === row && !enemy.isBoss)
          return (
            <div
              className={['row', occupant?.id === viewerId ? 'row--viewer' : ''].filter(Boolean).join(' ')}
              key={row}
              ref={occupant?.id === viewerId ? viewerRowRef : undefined}
            >
              {pendingPotionDef?.target === 'row' ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => consumePotion(pendingPotion!, { enemyRow: row })}
                >
                  Target row {row + 1}
                </button>
              ) : null}
              {pendingPowerDef?.target === 'row' ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => usePower(pendingPowerUid!, { enemyRow: row })}
                >
                  Target row {row + 1}
                </button>
              ) : null}
              {pendingTrigger?.playerId === viewer.id && pendingTrigger.rows?.some((target) => target.row === row) ? (
                <button
                  type="button"
                  className="row__potion-target"
                  disabled={usingTrigger}
                  onClick={() => resolveTrigger(row)}
                >
                  Resolve {pendingTrigger.label} in row {row + 1}
                </button>
              ) : null}
              {(pendingEvokeUsesRows && pendingEvokeTargetUids.has(lightningRowTarget(row))) ||
              pendingStartEvokeRows.some((target) => target.row === row) ? (
                <button
                  type="button"
                  className="row__potion-target"
                  onClick={() => {
                    const startTarget = pendingStartEvokeRows.find((target) => target.row === row)
                    if (startTarget) {
                      chooseStartTurnEvokeEnemy(startTarget.uid)
                      return
                    }
                    const targets = [...pending!.evokeEnemyUids]
                    targets[pendingEvokeTarget] = lightningRowTarget(row)
                    stageOrCommit({ ...pending!, evokeEnemyUids: targets })
                  }}
                >
                  Evoke Lightning in row {row + 1}
                </button>
              ) : null}
              <div className="row__seat">
                {occupant ? (
                  <>
                    <button
                      type="button"
                      className={[
                        'seat',
                        occupant.id === viewerId ? 'seat--viewer' : '',
                        occupant.dead ? 'seat--dead' : '',
                        struck.has(occupant.id) ? strikeClass('seat', beat) : '',
                        (!occupant.dead && ((pendingPotion !== null && potionDef(pendingPotion).supportTarget === 'anyPlayer') ||
                          (independentPlayerPending && enemyChoicesDone && choiceSatisfied) ||
                          (pending?.needsAlly && pending.playerId === null && enemyChoicesDone && choiceSatisfied) ||
                          (switchChoiceReady && occupant.id !== viewerId))
                        )
                          ? 'seat--targetable'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onAllyClick(occupant)}
                      aria-label={describeSeat(occupant)}
                    >
                      <span className="seat__name">{occupant.name}</span>
                      <span className="bar">
                        <span
                          className="bar__fill bar__fill--hp"
                          data-health={healthBand(occupant.hp, occupant.maxHp)}
                          style={{ width: `${Math.round((occupant.hp / occupant.maxHp) * 100)}%` }}
                        />
                        <span className="bar__label">
                          {occupant.hp}/{occupant.maxHp}
                        </span>
                      </span>
                      <TokenRow
                        orbs={occupant.character === 'defect'
                          ? occupant.orbs
                          : occupant.orbs.filter((orb) => orb !== null)}
                        block={occupant.block}
                        strength={occupant.strength}
                        vulnerable={occupant.vulnerable}
                        weak={occupant.weak}
                        shivs={occupant.shivs}
                        miracles={occupant.miracles}
                        clawCubes={occupant.clawCubesGainedThisCombat}
                      />
                      {occupant.strengthLossAtEndOfTurn > 0 ? (
                        <span className="seat__pending">
                          −{occupant.strengthLossAtEndOfTurn} Strength at end of turn
                        </span>
                      ) : null}
                      {occupant.drawLocked ? (
                        <span className="seat__pending">Cannot draw more cards this turn</span>
                      ) : null}
                      {(occupant.doubledAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Double Tap · next {occupant.doubledAttacksThisTurn} Attack{
                            occupant.doubledAttacksThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {(occupant.doubledCardsThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Echo Form · next {occupant.doubledCardsThisTurn} Attack or Skill card{
                            occupant.doubledCardsThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {(occupant.doubledSkillsThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Burst · next {occupant.doubledSkillsThisTurn} Skill{
                            occupant.doubledSkillsThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {occupant.hpLossLimitThisRound !== undefined ? (
                        <span className="seat__pending">
                          Apparition · {Math.max(0, occupant.hpLossLimitThisRound - (occupant.hpLostThisRound ?? 0))} HP loss remaining
                        </span>
                      ) : null}
                      {occupant.potions.length > 0 ? (
                        <span className="seat__potions" title="Held potions">
                          <Icon name="potion" size={14} /> {potionSummary(occupant)}
                        </span>
                      ) : null}
                      {occupant.stance !== 'neutral' ? (
                        <span className={`stance stance--${occupant.stance}`}>{occupant.stance}</span>
                      ) : null}
                    </button>
                    <PowerRow powers={occupant.powers} />
                  </>
                ) : (
                  <span className="seat seat--empty">empty row</span>
                )}
              </div>
              <div className="row__enemies" data-enemies={foes.length}>
                {foes.length === 0 ? (
                  <span className="muted">clear</span>
                ) : (
                  foes.map((enemy) => (
                    <EnemyCard
                      key={enemy.uid}
                      enemy={enemy}
                      label={enemyLabel(state.enemies, enemy)}
                      die={state.die}
                      struck={struck.has(enemy.uid)}
                      beat={beat}
                      targeted={(isStartTurnEnemyTarget(enemy.uid) ||
                        (pendingTrigger?.playerId === viewer.id &&
                          pendingTrigger.targets?.some((target) => target.uid === enemy.uid)) ||
                        ((pendingPotionDef?.target === 'enemy' || (pendingPowerDef && pendingPowerDef.target !== 'row') || pendingPotionOverflow > 0) || spendingShiv || (
                        ((pendingEvokeTarget < 0 && pending?.needsEnemy === true && !enemyChoicesDone) ||
                          (pendingEvokeTarget >= 0 && !pendingEvokeUsesRows && pendingEvokeTargetUids.has(enemy.uid))) && choiceSatisfied
                      ))) && !enemy.dead}
                      onClick={onEnemyClick}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* The round-end pause exists so the table can read what just happened.
          Without the combat log on screen the only trace of the Enemy Turn is
          a hit-point number quietly changing. */}
      {state.log.length > 0 ? (
        <ol className="combat__log" aria-label="Combat log" ref={logRef}>
          {/* Newest first, reversed HERE rather than with `column-reverse`:
              with the CSS trick the newest line is the last DOM child, so it
              is the one the scroll box pushes out of view and `li:first-child`
              highlights the oldest line instead.

              The whole round, not a fixed tail. A four-player enemy turn runs
              to fifteen lines, and a tail of ten dropped an entire "hit for 4"
              without the box even overflowing to hint that anything was
              missing. Scrolling is the only limiter. */}
          {roundLog(state.log).map((line, i) => (
            <li
              key={`${state.log.length - i}-${line}`}
              className={TURN_MARKER.test(line) ? 'combat__log-turn' : undefined}
            >
              {line}
            </li>
          ))}
        </ol>
      ) : null}

      <footer className="hand-area">
        <div className="hand-area__stats">
          <span className="pip pip--energy" title="Energy">
            <IconValue name="energy" value={viewer.energy} size={26} />
          </span>
          {/* The piles read as stacks of cards with a count, not as three
              labelled fields. Their names live in the tooltip and the label. */}
          {/* A hidden span rather than aria-label: `aria-label` is prohibited
              on a generic role, so Chrome honoured it and other engines
              dropped it — leaving the row announcing "3 Energy 5 0 0". */}
          {(
            [
              ['draw', 'Draw pile', drawCount ?? viewer.draw.length, null],
              // Both of these are face UP on the table, so their top card is
              // public and worth naming. On the discard pile it is not even
              // decoration: Steam Barrier's Block depends on what that card
              // costs, and there was no way to tell in advance whether the card
              // in hand was worth 1 Block or 2. The draw pile gets no such name
              // -- it is face down to everyone, its owner included, which is
              // why the room layer redacts it.
              ['discard', 'Discard pile', viewer.discard.length, topOf(viewer.discard, viewer.powers, viewer.lostHpThisCombat)],
              ['exhaust', 'Exhaust pile', viewer.exhaust.length, topOf(viewer.exhaust, viewer.powers, viewer.lostHpThisCombat)],
            ] as const
          ).map(([kind, label, count, top]) => (
            <span className="pile" key={kind} title={top ? `${label} — ${top} on top` : label}>
              <span className={`pile__stack pile__stack--${kind}`} aria-hidden="true" />
              <span className="pile__count" aria-hidden="true">
                {count}
              </span>
              {top ? <span className="pile__top" aria-hidden="true">{top}</span> : null}
              <span className="visually-hidden">
                {top ? `${label}, ${count}, ${top} on top` : `${label}, ${count}`}
              </span>
            </span>
          ))}
        </div>
        {/* Fanned, the way a hand is actually held: each card tilted and
            lifted by its distance from the middle. The angle is set here
            because only the component knows how many cards there are. */}
        <div className="hand" data-count={viewer.hand.length}>
          {viewer.hand.map((card, index) => (
            <Card
              key={card.uid}
              fan={fanOf(index, viewer.hand.length)}
              card={card}
              cost={card.uid === forcedCardUid ? 0 : playCost(faceOf(cardDef(card.defId), card.upgraded), viewer, card)}
              playable={
                !usingCard &&
                !pendingTrigger &&
                !orderingStage &&
                (!pending?.choiceCards || pending.card.uid === card.uid) &&
                ((state.phase === 'player' && !forcedCard) || card.uid === forcedCardUid ||
                  (pending?.card.uid === forcedCardUid && pending.choice !== null && !pending.choiceCards) ||
                  (state.phase === 'copy' && pending?.cardInHand === false &&
                    pending.choice !== null && !pending.choiceCards)) &&
                // While a card is staged, other cards stay clickable only as
                // choice targets; an unaffordable card must never be stageable
                // or it strands the player in a pending state it cannot commit.
                (card.uid === forcedCardUid ||
                  (pending?.card.uid === forcedCardUid && pending.choice !== null &&
                    !pending.choiceCards && card.uid !== pending.card.uid) ||
                  canAfford(state, viewer, card, miracleOnCard, drawCount) ||
                  pending?.card.uid === card.uid ||
                  (pending?.choice != null && card.uid !== pending.card.uid))
              }
              selected={pending?.card.uid === card.uid}
              picked={pending?.picked.includes(card.uid) === true}
              onClick={onCardClick}
            />
          ))}
          {viewer.hand.length === 0 ? <span className="muted">no cards in hand</span> : null}
        </div>
      </footer>
    </div>
  )
}
