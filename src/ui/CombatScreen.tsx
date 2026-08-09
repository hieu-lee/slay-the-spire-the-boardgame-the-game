import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef, Effect } from '../game/cards.ts'
import {
  activatePotion,
  beginEndPlayerTurn,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  chooseEndTurnTarget,
  defaultEndTurnOrder,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  endPlayerTurn,
  enemyTurn,
  enemyLabel,
  nextEvokeChoice,
  overflowShivCount,
  playCard,
  previewCardChoice,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
  validEndTurnOrder,
} from '../game/combat.ts'
import type { CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, PotionContext } from '../game/combat.ts'
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
    kind: 'discard' | 'scry'
    cards: CardInstance[]
    spendMiracle: boolean
    enemyUid: string | null
  }
  partyEndTurnAbilities?: EndTurnAbility[]
  savedEndTurnOrder?: string[]
  endTurnCoordinatorId?: string | null
  /** Room snapshot version; omitted for the local table. */
  authoritativeVersion?: number
  /** Successful REST refresh count; omitted for the local table. */
  authoritativeRefresh?: number
}

type UnknownPotionAction = { refreshAttempt: number; potionId: string; countBefore: number }
type UnknownCardAction = { refreshAttempt: number; cardUid: string }

/** What a card still needs before it can be played. */
type Pending = {
  card: CardInstance
  needsEnemy: boolean
  /**
   * The card can land its support on someone other than the caster, as Defend+,
   * True Grit and Vigilance all can. Auto-committing these to the caster would
   * quietly remove the co-op play the card exists for.
   */
  needsAlly: boolean
  /** Gained Shivs exceeding the shared five-cube supply may attack now. */
  overflowShivs: number
  shivEnemyUids: string[]
  evokeSlots: number[]
  evokeEnemyUids: (string | null | undefined)[]
  mode: number | null
  enemyUid: string | null
  playerId: string | null
  /**
   * The card carries the area-of-effect burst, so the chosen enemy is only an
   * anchor: everything in its row is hit, and so is the boss. Without saying
   * so, Cleave and a Strike look like the same interaction — pick one enemy —
   * and the player never learns why they would hold Cleave for a crowd.
   */
  hitsRow: boolean
  /** Cards that must be picked, as Survivor, Acrobatics and Third Eye require. */
  choice: { kind: 'discard' | 'exhaust' | 'scry'; amount: number } | null
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
  discard: 'Order discards',
  enemy: 'Enemies act',
  roundEnd: 'Round over',
  won: 'Victory',
  lost: 'Defeat',
}

function requirementsOf(
  def: CardDef,
  allies: number,
  viewer: Pick<Player, 'orbs' | 'block' | 'strength'>,
  state: { players: readonly { shivs: number }[] },
): Omit<Pending, 'card' | 'picked' | 'enemyUid' | 'playerId' | 'shivEnemyUids' | 'evokeSlots' | 'evokeEnemyUids' | 'mode' | 'choiceCards' | 'choiceConfirmed'> {
  // The same predicate the engine uses to decide whether to REFUSE the play.
  // Two copies of this list drifted apart once already: the UI would prompt for
  // an enemy and the engine would then throw the choice away. The viewer goes
  // in because a counted attack with nothing to count reaches nobody, and
  // asking where to point it is asking a question with no consequence.
  const cardTarget = cardNeedsEnemy(def, viewer, false)
  const shivsGained = gainedShivs(def.effects)
  const overflowShivs = overflowShivCount(state, shivsGained)
  const needsEnemy = cardTarget || overflowShivs > 0
  // With one player on the board there is nobody to choose between, so asking
  // "who gets it" is a prompt with a single possible answer.
  const needsAlly = def.supportTarget === 'anyPlayer' && allies > 1
  const discard = def.effects.find((effect) => effect.kind === 'discard')
  const exhaust = def.effects.find((effect) => effect.kind === 'exhaustFromHand')
  const scried = def.effects.find((effect) => effect.kind === 'scry')
  const choice = discard
    ? { kind: 'discard' as const, amount: discard.amount }
    : exhaust
      ? { kind: 'exhaust' as const, amount: exhaust.amount }
      : scried
        ? { kind: 'scry' as const, amount: scried.amount }
        : null
  return { needsEnemy, needsAlly, overflowShivs, hitsRow: def.target === 'row', choice }
}

function pendingFor(
  card: CardInstance,
  choiceCards: CardInstance[] | null,
  state: { players: readonly (Pick<Player, 'dead' | 'shivs'>)[] },
  viewer: Pick<Player, 'orbs' | 'block' | 'strength'>,
): Pending {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  return {
    card,
    ...requirementsOf(def, state.players.filter((player) => !player.dead).length, viewer, state),
    enemyUid: null,
    playerId: null,
    shivEnemyUids: [],
    evokeSlots: [],
    evokeEnemyUids: [],
    mode: null,
    choiceCards,
    choiceConfirmed: false,
    picked: [],
  }
}

function gainedShivs(effects: readonly Effect[]): number {
  return effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv' ? effect.amount : 0), 0)
}

/**
 * The name and cost of the card on top of a face-up pile.
 *
 * The end of the array is the top: piles are stored bottom-first, and the most
 * recently discarded card is the one a card like Steam Barrier reads.
 */
function topOf(pile: readonly CardInstance[]): string | null {
  const top = pile.at(-1)
  if (!top) return null
  const def = faceOf(cardDef(top.defId), top.upgraded)
  return `${def.unplayable ? '—' : def.cost} · ${def.name}`
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
  ]
  for (const [label, value] of tokens) if (value > 0) parts.push(`${label} ${value}`)
  if (player.strengthLossAtEndOfTurn > 0) {
    parts.push(`Strength loss at end of turn ${player.strengthLossAtEndOfTurn}`)
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

function canAfford(player: Player, card: CardInstance, spendMiracle = false): boolean {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  if (def.unplayable) return false
  // An evoke with nothing charged is refused by the engine, and a refusal is
  // reference-equality — the UI has no way to explain it. Better to grey the
  // card out than to let the click land and appear to do nothing at all.
  if (def.effects.some((effect) => effect.kind === 'evoke' || effect.kind === 'recurseOrb') &&
    player.orbs.every((orb) => !orb)) {
    return false
  }
  if (spendMiracle && (def.cost === 'X' || def.cost === 0)) return false
  return def.cost === 'X' || def.cost <= player.energy + (spendMiracle ? 1 : 0)
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
  cardPreview,
  authoritativeVersion,
  authoritativeRefresh,
}: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [miracleOnCard, setMiracleOnCard] = useState(false)
  const [spendingShiv, setSpendingShiv] = useState(false)
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const [endTurnOrder, setEndTurnOrder] = useState<string[]>([])
  const [endTurnError, setEndTurnError] = useState('')
  const boardRef = useRef<HTMLDivElement | null>(null)
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const followViewerRow = useRef(true)
  const programmaticScrollTop = useRef<number | null>(null)
  const manualBoardScroll = useRef(false)
  const potionActionPending = useRef(false)
  const cardActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
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
    ? `${cardPreview.cardUid}\0${cardPreview.kind}\0${cardPreview.spendMiracle}\0${cardPreview.enemyUid ?? ''}\0${cardPreview.cards.map((card) => card.uid).join('\0')}`
    : ''
  const orderingStage = partyEndTurnAbilities !== undefined

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
    const card = unknownCardAction.current
    if (card && (
      (authoritativeRefresh !== undefined && authoritativeRefresh > card.refreshAttempt) ||
      (current && !current.hand.some((held) => held.uid === card.cardUid))
    )) {
      unknownCardAction.current = null
      cardActionPending.current = false
      setUsingCard(false)
    }
  }, [authoritativeRefresh, state, viewerId])

  function recenterViewerRow() {
    const board = boardRef.current
    revealViewerRow(board, viewerRowRef.current)
    programmaticScrollTop.current = board?.scrollTop ?? null
  }

  // A card staged but never targeted would otherwise keep prompting "Choose an
  // enemy" into the Enemy Turn, highlighting enemies that cannot be clicked —
  // and a staged card also belongs to the seat that staged it, so switching
  // seats must drop it rather than aim another player's hand at the board.
  useEffect(() => {
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, viewerId])

  useEffect(() => {
    if (!orderingStage) return
    setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [orderingStage])

  // A private reveal is room state, not transient component state: restore it
  // after a reconnect so the player must finish the card they already saw.
  useEffect(() => {
    if (!cardPreview || !viewer) {
      if (onAction) setPending((current) => current?.choiceCards ? null : current)
      return
    }
    if (usingCard) return
    const card = viewer.hand.find((held) => held.uid === cardPreview.cardUid)
    if (!card) {
      if (onAction) setPending((current) => current?.choiceCards ? null : current)
      return
    }
    const next = pendingFor(card, cardPreview.cards, state, viewer)
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

  // Native modal semantics make every control behind a committed reveal inert
  // and keep keyboard focus inside the choice without a custom focus trap.
  useEffect(() => {
    const dialog = choiceDialogRef.current
    if (!dialog) return
    if (pending?.choiceCards && !pending.choiceConfirmed) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [pending?.choiceCards, pending?.choiceConfirmed])

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
    setPending((current) => {
      if (!current) return current
      if (!viewer.hand.some((card) => card.uid === current.card.uid)) return null
      const def = faceOf(cardDef(current.card.defId), current.card.upgraded)
      const overflowShivs = overflowShivCount(state, gainedShivs(def.effects))
      const overflowChanged = overflowShivs !== current.overflowShivs
      const enemyUid = current.enemyUid && alive.has(current.enemyUid) ? current.enemyUid : null
      const shivEnemyUids = overflowChanged
        ? []
        : current.shivEnemyUids.filter((uid) => alive.has(uid))
      const needsEnemy = cardNeedsEnemy(def, viewer, false) || overflowShivs > 0
      const invalidEvokeTarget = current.evokeEnemyUids.some((target) =>
        typeof target === 'string' && !alive.has(target))
      const evokeSlots = invalidEvokeTarget ? [] : current.evokeSlots
      const evokeEnemyUids = invalidEvokeTarget ? [] : current.evokeEnemyUids
      if (overflowChanged && !needsEnemy && !current.needsAlly && !current.choice &&
        !nextEvokeChoice(def, viewer, evokeSlots) &&
        !evokeEnemyUids.some((target) => target === undefined)) return null
      if (
        overflowShivs === current.overflowShivs &&
        enemyUid === current.enemyUid &&
        shivEnemyUids.length === current.shivEnemyUids.length &&
        !invalidEvokeTarget
      ) return current
      return { ...current, overflowShivs, needsEnemy, enemyUid, shivEnemyUids, evokeSlots, evokeEnemyUids }
    })
  }, [state, viewer])

  useEffect(() => {
    if (onAction) return
    potionActionPending.current = false
    setUsingPotion(false)
  }, [onAction, state])

  useEffect(() => {
    if (state.phase !== 'discard') {
      setDiscardTops({})
      setDiscardOrders({})
    }
    if (state.phase !== 'player') setEndTurnOrder([])
  }, [state.phase])

  useEffect(() => {
    if (state.phase !== 'discard' || !savedDiscardOrder) return
    setDiscardOrders({ [viewerId]: savedDiscardOrder })
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
  const pendingPotionOverflow = potionOverflowRequired
  const livingPlayers = state.players.filter((player) => !player.dead)
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !faceOf(cardDef(card.defId), card.upgraded).retain)
  const viewerDiscardTop = discardTops[viewer.id] && discardableHand.some((card) => card.uid === discardTops[viewer.id])
    ? discardTops[viewer.id]
    : discardableHand.at(-1)?.uid ?? ''
  const abilities = onAction ? (partyEndTurnAbilities ?? []) : endTurnAbilities(state)
  const defaultOrder = defaultEndTurnOrder(abilities)
  const viewerEndTurnOrder = validEndTurnOrder(abilities, endTurnOrder)
    ? endTurnOrder
    : defaultOrder
  const canOrderEndTurn = !orderingStage || viewer.id === endTurnCoordinatorId

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
    const top = selected && discardableHand.some((card) => card.uid === selected)
      ? selected
      : discardableHand.at(-1)?.uid
    const order = top
      ? [...viewer.hand.filter((card) => card.uid !== top), viewer.hand.find((card) => card.uid === top)!]
      : viewer.hand
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
    return combat.phase === 'player' && player ? { combat, player } : null
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
        const current = stateRef.current.players.find((player) => player.id === viewerId)
        if (
          (current && current.potions.filter((held) => held === potionId).length < potionCountBefore) ||
          (refreshAttempt !== undefined && refreshRef.current !== undefined && refreshRef.current > refreshAttempt)
        ) unlock()
        else if (refreshAttempt !== undefined) {
          unknownPotionAction.current = { refreshAttempt, potionId, countBefore: potionCountBefore }
        } else unlock()
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
  // Ordinary costs choose from the visible hand minus the card being played.
  // Post-draw costs choose from the private preview, which already models the
  // hand at the exact clause where the engine will charge it.
  const choicePoolSize = pending?.choiceCards?.length ?? Math.max(0, viewer.hand.length - 1)
  const choiceNeeded = pending?.choice && pending.choice.kind !== 'scry'
    ? Math.min(pending.choice.amount, choicePoolSize)
    : 0
  const pendingDef = pending ? faceOf(cardDef(pending.card.defId), pending.card.upgraded) : null
  const handChoiceSatisfied = pending?.choice?.kind === 'scry'
    ? true
    : pending?.choice ? pending.picked.length === choiceNeeded : true
  const revealedChoiceSatisfied = !pending?.choiceCards || pending.choiceConfirmed
  const modeSatisfied = !pendingDef?.modes || pending?.mode !== null
  const choiceSatisfied = handChoiceSatisfied && revealedChoiceSatisfied && modeSatisfied
  const pendingNeedsCardEnemy = pendingDef ? cardNeedsEnemy(pendingDef, viewer, false) : false
  const pendingEvokeChoice = pendingDef && pending
    ? nextEvokeChoice(pendingDef, viewer, pending.evokeSlots, pending.mode ?? undefined)
    : null
  const pendingEvokeTarget = pending?.evokeEnemyUids.findIndex((target) => target === undefined) ?? -1
  const evokeChoicesDone = pendingEvokeChoice === null && pendingEvokeTarget < 0
  const enemyChoicesDone = pending ? (
    evokeChoicesDone &&
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.shivEnemyUids.length >= pending.overflowShivs
  ) : true

  function commit(next: Pending, skipOverflow = false) {
    if (cardActionPending.current) return
    const context = {
      enemyUid: next.enemyUid,
      playerId: next.playerId ?? viewer!.id,
      mode: next.mode ?? undefined,
      discardUids: next.choice?.kind === 'discard' ? next.picked : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' ? next.picked : undefined,
      scryDiscardUids: next.choice?.kind === 'scry' ? next.picked : undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
      evokeSlots: next.evokeSlots,
      evokeEnemyUids: next.evokeEnemyUids as (string | null)[],
    }
    // The online draw pile is redacted. The room has already bound this action
    // to its private preview, so only the authoritative engine can validate it.
    const result = onAction && next.choiceCards ? undefined : playCard(state, viewer!.id, next.card.uid, context)
    if (result === state) {
      if (next.shivEnemyUids.length > 0 || next.evokeSlots.length > 0) {
        setPending({ ...next, shivEnemyUids: [], evokeSlots: [], evokeEnemyUids: [] })
      }
      return
    }
    const action = {
      kind: 'playCard',
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
          const refreshAttempt = outcome.refreshAttempt ?? refreshRef.current
          if (
            (current && !current.hand.some((card) => card.uid === next.card.uid)) ||
            (refreshAttempt !== undefined && refreshRef.current !== undefined && refreshRef.current > refreshAttempt)
          ) unlock()
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = { refreshAttempt, cardUid: next.card.uid }
          } else unlock()
          return
        }
        unlock()
        if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
          const authoritative = reconciliation(outcome)
          if (!authoritative || !authoritative.player.hand?.some((card) => card.uid === next.card.uid)) return
          if (next.choiceCards) {
            setMiracleOnCard(usingMiracle)
            requestChoicePreview(next.card, next.enemyUid)
            return
          }
          const def = faceOf(cardDef(next.card.defId), next.card.upgraded)
          const overflowShivs = overflowShivCount(authoritative.combat, gainedShivs(def.effects))
          const needsEnemy = cardNeedsEnemy(def, authoritative.player, false) || overflowShivs > 0
          const needsAlly = def.supportTarget === 'anyPlayer' &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          setMiracleOnCard(usingMiracle)
          if (needsEnemy || needsAlly || def.modes || next.choice || nextEvokeChoice(def, authoritative.player, [])) {
            setPending({
              ...next,
              needsEnemy,
              needsAlly,
              overflowShivs,
              enemyUid: null,
              playerId: null,
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
    const poolSize = next.choiceCards?.length ?? Math.max(0, viewer!.hand.length - 1)
    const owed = next.choice && next.choice.kind !== 'scry' ? Math.min(next.choice.amount, poolSize) : 0
    const selectionReady = next.choice?.kind === 'scry' || next.picked.length === owed
    const ready = selectionReady && (!next.choiceCards || next.choiceConfirmed) &&
      (!def.modes || next.mode !== null) &&
      !nextEvokeChoice(def, viewer!, next.evokeSlots, next.mode ?? undefined) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (!cardNeedsEnemy(def, viewer!, false) || next.enemyUid !== null) &&
      next.shivEnemyUids.length >= next.overflowShivs && (!next.needsAlly || next.playerId !== null)
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

  function onCardClick(card: CardInstance) {
    if (cardActionPending.current || orderingStage) return
    setSpendingShiv(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    // While a card is waiting on a choice, clicks in hand pick cards for it.
    if (pending?.choice && !pending.choiceCards && card.uid !== pending.card.uid) {
      const already = pending.picked.includes(card.uid)
      const need = Math.min(pending.choice.amount, Math.max(0, viewer!.hand.length - 1))
      const picked = already
        ? pending.picked.filter((uid) => uid !== card.uid)
        : [...pending.picked, card.uid].slice(-need)
      const next = { ...pending, picked }
      setPending(next)
      // True Grit exhausts a card AND blocks any player, so satisfying the
      // choice must not skip the ally step.
      if (!next.needsEnemy && !next.needsAlly && picked.length === need) {
        stageOrCommit(next)
      }
      return
    }

    // A normal staged card can be cancelled. A card that already revealed
    // hidden information is committed and must be finished.
    if (pending?.card.uid === card.uid) {
      if (pending.choiceCards) return
      setPending(null)
      return
    }

    if (pending?.choiceCards) return

    const def = faceOf(cardDef(card.defId), card.upgraded)
    if (cardNeedsChoicePreview(def)) {
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
    const owed = next.choice
      ? Math.min(next.choice.amount, Math.max(0, viewer!.hand.length - 1))
      : 0
    if (!next.needsEnemy && !next.needsAlly && owed === 0 &&
      !def.modes && !nextEvokeChoice(def, viewer!, next.evokeSlots)) commit(next)
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
      const targets = [...pending.evokeEnemyUids]
      targets[pendingEvokeTarget] = enemy.uid
      stageOrCommit({ ...pending, evokeEnemyUids: targets })
      return
    }
    if (!evokeChoicesDone) return
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    const normalTargetNeeded = pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
      if (pendingDef && cardNeedsChoicePreview(pendingDef)) {
        requestChoicePreview(pending.card, enemy.uid)
        return
      }
      const next = { ...pending, enemyUid: enemy.uid }
      if (next.overflowShivs > 0 || next.needsAlly) setPending(next)
      else commit(next)
      return
    }
    if (pending.shivEnemyUids.length < pending.overflowShivs) {
      const next = { ...pending, shivEnemyUids: [...pending.shivEnemyUids, enemy.uid] }
      if (next.shivEnemyUids.length < next.overflowShivs || next.needsAlly) setPending(next)
      else commit(next)
    }
  }

  function onEvokeClick(slot: number) {
    if (!pending || !pendingEvokeChoice || pendingEvokeTarget >= 0 || !choiceSatisfied) return
    const option = pendingEvokeChoice.options.find((candidate) => candidate.slot === slot)
    if (!option) return
    stageOrCommit({
      ...pending,
      evokeSlots: [...pending.evokeSlots, slot],
      evokeEnemyUids: [...pending.evokeEnemyUids, option.orb === 'frost' ? null : undefined],
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
    if (!pending || !pending.needsAlly || !enemyChoicesDone || !choiceSatisfied) return
    commit({ ...pending, playerId: ally.id })
  }

  // Ordered by what the player must do NEXT: an unsatisfied choice first, then
  // whatever target is still outstanding. Showing the choice text after it is
  // satisfied would leave the player stuck looking at a completed instruction.
  const overflowOnly = (pending?.overflowShivs ?? 0) > 0 && !pendingNeedsCardEnemy
  const enemyPrompt = overflowOnly
    ? `Choose overflow Shiv target ${(pending?.shivEnemyUids.length ?? 0) + 1}/${pending?.overflowShivs}, or skip the rest`
    : pending?.hitsRow
      ? state.enemies.some((enemy) => enemy.isBoss && !enemy.dead)
        ? 'Choose an enemy — its whole row is hit, and the boss'
        : 'Choose an enemy — its whole row is hit'
      : 'Choose an enemy'
  const prompt = pendingPotionDef
    ? pendingPotionDef.target === 'row'
      ? `Choose a row for ${pendingPotionDef.name}`
      : pendingPotionOverflow > 0
        ? `Choose overflow Shiv target ${potionShivEnemyUids.length + 1}/${pendingPotionOverflow}, or skip the rest`
        : `Choose ${pendingPotionDef.target ? 'an enemy' : 'a player'} for ${pendingPotionDef.name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : pendingDef?.modes && !modeSatisfied
      ? `Choose how to play ${pendingDef.name}`
    : pending?.choiceCards && !pending.choiceConfirmed
      ? pending.choice?.kind === 'scry'
        ? `Scry ${pending.choice.amount} — choose any cards to discard`
        : `Discard ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} after drawing`
    : pending?.choice && !handChoiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
      : pendingEvokeTarget >= 0
        ? 'Choose an enemy for this evoke'
        : pendingEvokeChoice
          ? `Choose Orb to evoke ${pendingEvokeChoice.index + 1}`
          : pending?.needsEnemy && !enemyChoicesDone
        ? enemyPrompt
        : pending?.needsAlly && !pending.playerId
          ? 'Choose who gets it'
          : null

  return (
    <div className="combat" data-phase={state.phase}>
      <header className="combat__bar">
        <span className="combat__turn">Turn {state.turn}</span>
        <span className="combat__die" title="The round's shared die">
          <Icon name={dieIcon(state.die)} size={26} decorative={false} />
        </span>
        <span className={`combat__phase combat__phase--${state.phase}`}>{PHASE_LABEL[state.phase]}</span>
        <span className="combat__actions">
          {!viewer.dead && (state.phase === 'player' || state.phase === 'discard') ? (
            <>
              {state.phase === 'player' && !orderingStage ? [...new Set(viewer.potions)].map((potionId) => {
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
              {state.phase === 'player' && !orderingStage && viewer.shivs > 0 ? (
                <button
                  type="button"
                  disabled={Boolean(pending?.choiceCards)}
                  aria-pressed={spendingShiv}
                  onClick={() => {
                    setPending(null)
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
              {state.phase === 'player' && !orderingStage && viewer.miracles > 0 ? (
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
              {state.phase === 'discard' && discardableHand.length > 1 ? (
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
                    {discardableHand.map((card) => {
                      const def = faceOf(cardDef(card.defId), card.upgraded)
                      return <option key={card.uid} value={card.uid}>{`${def.unplayable ? '—' : def.cost} · ${def.name}`}</option>
                    })}
                  </select>
                </label>
              ) : null}
              {state.phase === 'player' && (abilities.length > 1 ||
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
              <button type="button" onClick={finishTurn}
                disabled={Boolean(pending?.choiceCards) || (orderingStage && viewer.id !== endTurnCoordinatorId)}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
                  : orderingStage
                    ? viewer.id === endTurnCoordinatorId ? 'Resolve end turn' : 'Waiting for end-turn order'
                    : 'End turn'}
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
              onClick={() => onAction ? onAction({ kind: 'startTurn' }) : onChange?.(startPlayerTurn(state))}
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
          {pending && overflowOnly ? (
            <button type="button" className="prompt__cancel" onClick={() => commit(pending, true)}>
              Skip remaining overflow attacks
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
          {!pending?.choiceCards ? <button
            type="button"
            className="prompt__cancel"
            onClick={() => {
              setPending(null)
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

      {pending?.choiceCards && pending.choice && !pending.choiceConfirmed ? (
        <dialog ref={choiceDialogRef} className="choice-modal" aria-labelledby="choice-modal-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="choice-modal-title">
              {pending.choice.kind === 'scry' ? `Scry ${pending.choice.amount}` : `Choose ${choiceNeeded} to discard`}
            </h2>
            <p>
              {pending.choice.kind === 'scry'
                ? 'Select any revealed cards to discard; unselected cards stay on top in order.'
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
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
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
                targeted={((pendingPotionDef?.target === 'enemy' || pendingPotionOverflow > 0) || spendingShiv || (
                  ((pending?.needsEnemy === true && !enemyChoicesDone) || pendingEvokeTarget >= 0) && choiceSatisfied
                )) && !enemy.dead}
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
                          (pending?.needsAlly && enemyChoicesDone && choiceSatisfied))
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
                        orbs={occupant.orbs}
                        block={occupant.block}
                        strength={occupant.strength}
                        vulnerable={occupant.vulnerable}
                        weak={occupant.weak}
                        shivs={occupant.shivs}
                        miracles={occupant.miracles}
                      />
                      {occupant.strengthLossAtEndOfTurn > 0 ? (
                        <span className="seat__pending">
                          −{occupant.strengthLossAtEndOfTurn} Strength at end of turn
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
                      targeted={((pendingPotionDef?.target === 'enemy' || pendingPotionOverflow > 0) || spendingShiv || (
                        ((pending?.needsEnemy === true && !enemyChoicesDone) || pendingEvokeTarget >= 0) && choiceSatisfied
                      )) && !enemy.dead}
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
              ['discard', 'Discard pile', viewer.discard.length, topOf(viewer.discard)],
              ['exhaust', 'Exhaust pile', viewer.exhaust.length, topOf(viewer.exhaust)],
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
              playable={
                !usingCard &&
                !orderingStage &&
                (!pending?.choiceCards || pending.card.uid === card.uid) &&
                state.phase === 'player' &&
                // While a card is staged, other cards stay clickable only as
                // choice targets; an unaffordable card must never be stageable
                // or it strands the player in a pending state it cannot commit.
                (canAfford(viewer, card, miracleOnCard) ||
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
