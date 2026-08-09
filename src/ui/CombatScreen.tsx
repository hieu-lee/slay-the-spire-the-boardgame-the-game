import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import {
  activatePotion,
  beginEndPlayerTurn,
  cardNeedsEnemy,
  endPlayerTurn,
  enemyTurn,
  enemyLabel,
  playCard,
  spendMiracle,
  spendShiv,
  startPlayerTurn,
} from '../game/combat.ts'
import type { CombatState, DiscardOrders } from '../game/combat.ts'
import { potionDef } from '../game/relics.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import { CAPS } from '../game/types.ts'
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
  onAction?: (action: Record<string, unknown>) => void | Promise<unknown>
  drawCount?: number
  decidedPlayerIds?: string[]
  savedDiscardOrder?: string[]
}

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
  enemyUid: string | null
  playerId: string | null
  /**
   * The card carries the area-of-effect burst, so the chosen enemy is only an
   * anchor: everything in its row is hit, and so is the boss. Without saying
   * so, Cleave and a Strike look like the same interaction — pick one enemy —
   * and the player never learns why they would hold Cleave for a crowd.
   */
  hitsRow: boolean
  /** Cards that must be picked out of hand, as Survivor and True Grit require. */
  choice: { kind: 'discard' | 'exhaust'; amount: number } | null
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
  viewer: Player,
  state: CombatState,
): Omit<Pending, 'card' | 'picked' | 'enemyUid' | 'playerId' | 'shivEnemyUids'> {
  // The same predicate the engine uses to decide whether to REFUSE the play.
  // Two copies of this list drifted apart once already: the UI would prompt for
  // an enemy and the engine would then throw the choice away. The viewer goes
  // in because a counted attack with nothing to count reaches nobody, and
  // asking where to point it is asking a question with no consequence.
  const cardTarget = cardNeedsEnemy(def, viewer)
  const shivsGained = def.effects.reduce(
    (sum, effect) => sum + (effect.kind === 'gainShiv' ? effect.amount : 0),
    0,
  )
  const shivsAvailable = CAPS.shivs - state.players.reduce((sum, player) => sum + player.shivs, 0)
  const overflowShivs = Math.max(0, shivsGained - Math.max(0, shivsAvailable))
  const needsEnemy = cardTarget || overflowShivs > 0
  // With one player on the board there is nobody to choose between, so asking
  // "who gets it" is a prompt with a single possible answer.
  const needsAlly = def.supportTarget === 'anyPlayer' && allies > 1
  const discard = def.effects.find((effect) => effect.kind === 'discard')
  const exhaust = def.effects.find((effect) => effect.kind === 'exhaustFromHand')
  const choice = discard
    ? { kind: 'discard' as const, amount: discard.amount }
    : exhaust
      ? { kind: 'exhaust' as const, amount: exhaust.amount }
      : null
  return { needsEnemy, needsAlly, overflowShivs, hitsRow: def.target === 'row', choice }
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
  if (def.effects.some((effect) => effect.kind === 'evoke') && player.orbs.every((orb) => !orb)) {
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
}: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [miracleOnCard, setMiracleOnCard] = useState(false)
  const [spendingShiv, setSpendingShiv] = useState(false)
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [usingPotion, setUsingPotion] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const boardRef = useRef<HTMLDivElement | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const followViewerRow = useRef(true)
  const programmaticScrollTop = useRef<number | null>(null)
  const manualBoardScroll = useRef(false)
  const potionActionPending = useRef(false)
  const viewer = state.players.find((player) => player.id === viewerId)
  const rows = useMemo(() => rowsOf(state), [state])
  const savedDiscardKey = savedDiscardOrder?.join('\0')

  const { struck, beat } = useStruck(state)

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
  }, [state.phase, viewerId])

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
  }, [state.phase])

  useEffect(() => {
    if (state.phase !== 'discard' || !savedDiscardOrder) return
    setDiscardOrders({ [viewerId]: savedDiscardOrder })
    const top = savedDiscardOrder.at(-1)
    if (top) setDiscardTops({ [viewerId]: top })
  }, [savedDiscardKey, state.phase, viewerId])

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
  const livingPlayers = state.players.filter((player) => !player.dead)
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  const discardableHand = viewer.hand.filter((card) =>
    !faceOf(cardDef(card.defId), card.upgraded).retain)
  const viewerDiscardTop = discardTops[viewer.id] && discardableHand.some((card) => card.uid === discardTops[viewer.id])
    ? discardTops[viewer.id]
    : discardableHand.at(-1)?.uid ?? ''

  function finishTurn() {
    if (!viewer) return
    if (state.phase === 'player') {
      if (onAction) onAction({ kind: 'endTurn' })
      else onChange?.(beginEndPlayerTurn(state))
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

  function consumePotion(
    potionId: string,
    enemyUid: string | null = null,
    targetPlayerId: string | null = null,
  ) {
    if (potionActionPending.current) return
    potionActionPending.current = true
    setUsingPotion(true)
    setPending(null)
    setSpendingShiv(false)
    setPendingPotion(null)
    if (onAction) {
      const finish = () => {
        potionActionPending.current = false
        setUsingPotion(false)
      }
      Promise.resolve(onAction({ kind: 'usePotion', potionId, enemyUid, targetPlayerId })).then(finish, finish)
      return
    }
    const result = activatePotion(state, viewer!.id, potionId, enemyUid, targetPlayerId)
    if (result !== state) onChange?.(result)
    else {
      potionActionPending.current = false
      setUsingPotion(false)
    }
  }
  // The engine charges a consuming clause against the hand AS THAT CLAUSE
  // RESOLVES; this clamp measures the hand before the card is played. The two
  // agree for every shipped card only because none of them draws before it
  // charges — a rule `verify-architecture.mjs` enforces, because the player
  // cannot nominate a card that has not been dealt yet. Do not treat this as a
  // general mirror of the engine: it is a clamp that is correct given that rule.
  const choiceNeeded = pending?.choice
    ? Math.min(pending.choice.amount, Math.max(0, viewer.hand.length - 1))
    : 0
  const choiceSatisfied = pending?.choice ? pending.picked.length === choiceNeeded : true
  const pendingNeedsCardEnemy = pending ? cardNeedsEnemy(
    faceOf(cardDef(pending.card.defId), pending.card.upgraded),
    viewer,
  ) : false
  const enemyChoicesDone = pending ? (
    (!pendingNeedsCardEnemy || pending.enemyUid !== null) &&
    pending.shivEnemyUids.length >= pending.overflowShivs
  ) : true

  function commit(next: Pending) {
    const action = {
      kind: 'playCard',
      cardUid: next.card.uid,
      enemyUid: next.enemyUid,
      playerId: next.playerId ?? viewer!.id,
      discardUids: next.choice?.kind === 'discard' ? next.picked : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' ? next.picked : undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
    }
    if (onAction) {
      setMiracleOnCard(false)
      setPending(null)
      onAction(action)
      return
    }
    const result = playCard(state, viewer!.id, next.card.uid, {
      enemyUid: next.enemyUid,
      playerId: next.playerId ?? viewer!.id,
      discardUids: next.choice?.kind === 'discard' ? next.picked : undefined,
      exhaustUids: next.choice?.kind === 'exhaust' ? next.picked : undefined,
      spendMiracle: miracleOnCard,
      shivEnemyUids: next.shivEnemyUids,
    })
    // Reference equality means the engine refused the play.
    if (result !== state) {
      setMiracleOnCard(false)
      onChange?.(result)
    }
    setPending(null)
  }

  function onCardClick(card: CardInstance) {
    setSpendingShiv(false)
    setPendingPotion(null)
    // While a card is waiting on a choice, clicks in hand pick cards for it.
    if (pending?.choice && card.uid !== pending.card.uid) {
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
        commit(next)
      }
      return
    }

    // Clicking the staged card again cancels it.
    if (pending?.card.uid === card.uid) {
      setPending(null)
      return
    }

    const def = faceOf(cardDef(card.defId), card.upgraded)
    const living = state.players.filter((player) => !player.dead).length
    const next: Pending = {
      card,
      ...requirementsOf(def, living, viewer!, state),
      enemyUid: null,
      playerId: null,
      shivEnemyUids: [],
      picked: [],
    }
    setPending(next)
    // Only resolve on the spot when there is genuinely nothing left to pick —
    // including a cost the hand is too small to pay anything towards.
    const owed = next.choice
      ? Math.min(next.choice.amount, Math.max(0, viewer!.hand.length - 1))
      : 0
    if (!next.needsEnemy && !next.needsAlly && owed === 0) commit(next)
  }

  function onEnemyClick(enemy: Enemy) {
    if (pendingPotion) {
      if (potionDef(pendingPotion).targetsEnemy) consumePotion(pendingPotion, enemy.uid)
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
    if (!pending || !pending.needsEnemy || !choiceSatisfied) return
    const normalTargetNeeded = pendingNeedsCardEnemy && !pending.enemyUid
    if (normalTargetNeeded) {
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

  function onAllyClick(ally: Player) {
    if (ally.dead) return
    if (pendingPotion && potionDef(pendingPotion).supportTarget === 'anyPlayer') {
      consumePotion(pendingPotion, null, ally.id)
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
  const prompt = pendingPotion
    ? `Choose ${potionDef(pendingPotion).targetsEnemy ? 'an enemy' : 'a player'} for ${potionDef(pendingPotion).name}`
    : spendingShiv
    ? 'Choose an enemy for the Shiv'
    : pending?.choice && !choiceSatisfied
      ? `${pending.choice.kind === 'discard' ? 'Discard' : 'Exhaust'} ${choiceNeeded} card${
          choiceNeeded === 1 ? '' : 's'
        } — ${pending.picked.length}/${choiceNeeded} chosen`
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
              {state.phase === 'player' ? [...new Set(viewer.potions)].map((potionId) => {
                const potion = potionDef(potionId)
                const staged = pendingPotion === potionId
                const count = viewer.potions.filter((held) => held === potionId).length
                const needsTarget = potion.targetsEnemy || (
                  potion.supportTarget === 'anyPlayer' && livingPlayers.length > 1
                )
                return (
                  <button
                    type="button"
                    key={potionId}
                    disabled={usingPotion}
                    aria-pressed={needsTarget ? staged : undefined}
                    title={potion.text}
                    onClick={() => {
                      if (needsTarget) {
                        setPending(null)
                        setSpendingShiv(false)
                        setMiracleOnCard(false)
                        setPendingPotion(staged ? null : potionId)
                      } else consumePotion(potionId)
                    }}
                  >
                    <Icon name="potion" size={16} /> {staged ? '✓ ' : ''}{potion.name}{count > 1 ? ` ×${count}` : ''}
                  </button>
                )
              }) : null}
              {state.phase === 'player' && viewer.shivs > 0 ? (
                <button
                  type="button"
                  aria-pressed={spendingShiv}
                  onClick={() => {
                    setPending(null)
                    setMiracleOnCard(false)
                    setPendingPotion(null)
                    setSpendingShiv((current) => !current)
                  }}
                >
                  {spendingShiv ? '✓ ' : ''}Use Shiv
                </button>
              ) : null}
              {state.phase === 'player' && viewer.miracles > 0 ? (
                <button
                  type="button"
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
              <button type="button" onClick={finishTurn}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
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
            <button type="button" className="prompt__cancel" onClick={() => commit(pending)}>
              Skip remaining overflow attacks
            </button>
          ) : null}
          <button
            type="button"
            className="prompt__cancel"
            onClick={() => {
              setPending(null)
              setSpendingShiv(false)
              setPendingPotion(null)
            }}
          >
            Cancel
          </button>
        </p>
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
                targeted={((pendingPotion !== null && potionDef(pendingPotion).targetsEnemy) || spendingShiv || (
                  pending?.needsEnemy === true && !enemyChoicesDone && choiceSatisfied
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
                      targeted={((pendingPotion !== null && potionDef(pendingPotion).targetsEnemy) || spendingShiv || (
                        pending?.needsEnemy === true && !enemyChoicesDone && choiceSatisfied
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
