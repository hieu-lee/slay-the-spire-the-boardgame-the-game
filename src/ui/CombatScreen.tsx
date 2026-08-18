import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cardCost, cardDef, faceOf } from '../game/cards.ts'
import { potionIconPath } from '../game/assets.ts'
import type { CardDef, Effect } from '../game/cards.ts'
import {
  activatePower,
  activatePotion,
  activateRelic,
  beginEndPlayerTurn,
  STALE_END_TURN_ORDER,
  cardEnemyChoiceCount,
  cardIsPlayable,
  cardModeIsAvailable,
  cardNeedsChoicePreview,
  cardNeedsEnemy,
  cardPlayerChoiceCount,
  cardShivChoiceCount,
  cardPlayConditionMet,
  canActivatePotion,
  canActivateRelic,
  chosenEvokeOrbs,
  chooseEndTurnTarget,
  chooseDistilledCard,
  defaultEndTurnOrder,
  defaultStartTurnChoices,
  endTurnAbilities,
  endTurnChoiceId,
  endTurnChoiceTarget,
  endPlayerTurn,
  enemyTurn,
  enemyLabel,
  effectIsActive,
  facingChoicesAreValid,
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
  remainingRoundHpLoss,
  reachedTimeWarpLimit,
  resolveStartPlayerTurn,
  resolveStartTurnDiscard,
  resolveStartTurnScry,
  resolvePendingTrigger,
  spendMiracle,
  spendShiv,
  startTurnAbilities,
  startTurnDiscardPreview,
  startTurnScryAbilities,
  startTurnScryPreview,
  startTurnNeedsChoice,
  startPlayerTurnWithChoices,
  validEndTurnOrder,
} from '../game/combat.ts'
import type {
  CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, PotionContext, PowerContext,
  RelicContext, StartTurnAbility, StartTurnChoice, StartTurnScryAbility, StartTurnScryPreview,
} from '../game/combat.ts'
import { potionDef, relicAbilities, relicDef } from '../game/relics.ts'
import type { CardInstance, Enemy, Player } from '../game/types.ts'
import { CAPS } from '../game/types.ts'
import type { ActionOutcome } from '../multiplayer/useRoomSession.ts'
import { Card } from './Card.tsx'
import { Icon, IconValue, dieIcon } from './Icon.tsx'
import { EnemyCard } from './EnemyCard.tsx'
import { PowerRow } from './PowerRow.tsx'
import { OrbRow, TokenRow } from './TokenRow.tsx'
import {
  STAGE_GAP_REM,
  STAGE_MARGIN_REM,
  cardMotionDestination,
  drawnCardUids,
  healthBand,
  pendingUiSurvivesContext,
  shouldDisarmCardFlight,
  stageScaleFor,
  strikeClass,
} from './board-signals.ts'
import { playSoundEffect } from './sfx.ts'

type CombatScreenProps = {
  state: CombatState
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

type UnknownPotionAction = { refreshAttempt: number; potionId: string; countBefore: number }
type UnknownPowerAction = { refreshAttempt: number; powerUid: string }
type UnknownCardAction = { refreshAttempt: number; cardUid: string; copy: boolean; copiesBefore?: number }
type MotionKey = 'energy' | 'draw' | 'discard' | 'exhaust'
type CardFlight = {
  beat: number
  card: CardInstance
  destination: ReturnType<typeof cardMotionDestination>
}
type MotionSnapshot = {
  hand: readonly CardInstance[]
  energy: number
  draw: number
  discard: number
  exhaust: number
}
type PendingStartChoice =
  | { kind: 'enemy'; ability: StartTurnAbility }
  | { kind: 'player'; ability: StartTurnAbility }
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
  /** Effective X after a fixed-cost override; never sent as a player choice. */
  effectEnergy: number | null
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
): Omit<Pending, 'card' | 'cardInHand' | 'energySpent' | 'effectEnergy' | 'picked' | 'enemyUid' | 'playerId' | 'switchPlayerId' | 'switchChoiceDone' | 'enemyUids' | 'playerIds' | 'shivEnemyUids' | 'evokeSlots' | 'evokeEnemyUids' | 'mode' | 'choiceCards' | 'choiceConfirmed'> {
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
  const search = onPlayEffects.find((effect) =>
    effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice')
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
          ? { kind: 'search' as const, amount: search.kind === 'searchDraw' ? search.amount : 1 }
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
  const cost = forced ? 0 : playCost(def, viewer, card)
  const energySpent = copiedEnergySpent ?? (cost === 'X' ? null : 0)
  const effectEnergy = copiedEnergySpent ?? (def.cost === 'X' && cost !== 'X' ? cost : energySpent)
  const requirements = requirementsOf(
    def, state.players.filter((player) => !player.dead).length, viewer, state, effectEnergy ?? undefined, cardInHand,
  )
  return {
    card,
    cardInHand,
    energySpent,
    effectEnergy,
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
  let actors = [...row.querySelectorAll<HTMLElement>('.row__seat, .enemy')]
  const enemies = [...row.querySelectorAll<HTMLElement>('.enemy')]
  const bosses = [...board.querySelectorAll<HTMLElement>('.board__bosses .enemy:not(.enemy--dead)')]
  if (enemies.length === 0 && bosses.length > 0) actors = bosses
  const span = (items: HTMLElement[]): [number, number] => {
    const boxes = items.map((actor) => actor.getBoundingClientRect())
    return [Math.min(...boxes.map((box) => box.left)), Math.max(...boxes.map((box) => box.right))]
  }
  if (actors.length > 0 && enemies.length > 0) {
    const [left, right] = span(actors)
    if (right - left > board.clientWidth) actors = enemies
  }
  if (actors.length > 0) {
    const [left, right] = span(actors)
    board.scrollLeft += left - boardBox.left - (board.clientWidth - (right - left)) / 2
  }
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
  const parts = [`${player.name}, ${player.hp} of ${player.maxHp} hit points, row ${player.row + 1}`]
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
  if (player.cardPlayLocked) parts.push('cannot play additional cards this turn')
  if ((player.freeAttacksThisTurn ?? 0) > 0) parts.push('next Attack costs 0 this turn')
  if ((player.doubledAttacksThisTurn ?? 0) > 0) {
    parts.push(`Double Tap, next ${player.doubledAttacksThisTurn} Attack${player.doubledAttacksThisTurn === 1 ? '' : 's'} played twice`)
  }
  if ((player.tripledAttacksThisTurn ?? 0) > 0) {
    parts.push(`Blasphemy, next ${player.tripledAttacksThisTurn} Attack${player.tripledAttacksThisTurn === 1 ? '' : 's'} played three times`)
  }
  if ((player.doubledCardsThisTurn ?? 0) > 0) {
    parts.push(`Echo Form, next ${player.doubledCardsThisTurn} Attack or Skill card${
      player.doubledCardsThisTurn === 1 ? '' : 's'
    } played twice`)
  }
  if ((player.doubledSkillsThisTurn ?? 0) > 0) {
    parts.push(`Burst, next ${player.doubledSkillsThisTurn} Skill${player.doubledSkillsThisTurn === 1 ? '' : 's'} played twice`)
  }
  const hpLossRemaining = remainingRoundHpLoss(player)
  if (hpLossRemaining !== undefined) {
    parts.push(`${player.powers.some((power) => power.defId === 'wraith_form') ? 'Wraith Form' : 'Apparition'} protection, ${hpLossRemaining} hit point loss remaining this round`)
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
  if (reachedTimeWarpLimit(state, player)) return false
  const cost = playCost(def, player, card)
  if (spendMiracle && (cost === 'X' || cost === 0)) return false
  if (def.cost === 'X' && cost !== 'X' && cost < (def.minimumX ?? 0)) return false
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
function useStruck(
  state: CombatState,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
): { struck: Set<string>; beats: Map<string, number>; damage: Map<string, number> } {
  const previous = useRef(new Map<string, number>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const damage = useRef(new Map<string, number>())
  const beats = useRef(new Map<string, number>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [struck, setStruck] = useState<Set<string>>(new Set())

  useEffect(() => {
    const now = new Map<string, number>()
    const hurt = new Set<string>()
    const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.hp)
      const before = previous.current.get(id)
      if (!refreshed && before !== undefined && entity.hp < before) {
        hurt.add(id)
        damage.current.set(id, before - entity.hp)
      }
    }
    previous.current = now
    if (refreshed) {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      damage.current.clear()
      setStruck((current) => current.size === 0 ? current : new Set())
      return
    }
    if (hurt.size === 0) return

    if (state.phase !== 'lost' && state.players.some((player) => hurt.has(player.id))) playSoundEffect('hurt')

    // Each actor owns its beat and expiry. Concurrent hits must not cancel one
    // another, while a second hit on the same actor must restart its animation.
    setStruck((current) => new Set([...current, ...hurt]))
    for (const id of hurt) {
      const beat = (beats.current.get(id) ?? 0) + 1
      beats.current.set(id, beat)
      const prior = timers.current.get(id)
      if (prior) clearTimeout(prior)
      timers.current.set(id, setTimeout(() => {
        if (beats.current.get(id) !== beat) return
        timers.current.delete(id)
        damage.current.delete(id)
        setStruck((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, 380))
    }
  }, [authoritativeConnected, authoritativeRestoration, state])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return { struck, beats: beats.current, damage: damage.current }
}

function useCombatSoundEffects(
  state: CombatState,
  viewerId: string,
  animateOpeningHand: boolean,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
) {
  const previous = useRef<CombatState | null>(null)
  const previousViewer = useRef(viewerId)
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)

  useEffect(() => {
    const before = previous.current
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false || previousViewer.current !== viewerId
    previous.current = state
    previousViewer.current = viewerId
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected

    const viewer = state.players.find((player) => player.id === viewerId)
    if (!before) {
      if (animateOpeningHand && viewer?.hand.length) playSoundEffect('draw')
      return
    }
    if (restored || state.phase === 'won' || state.phase === 'lost') return
    const priorPlayers = new Map(before.players.map((player) => [player.id, player]))
    if (state.players.some((player) => player.hp > (priorPlayers.get(player.id)?.hp ?? player.hp))) {
      playSoundEffect('heal')
    }
    const priorViewer = before.players.find((player) => player.id === viewerId)
    if (viewer && priorViewer && drawnCardUids(priorViewer.hand, viewer.hand).length > 0) {
      playSoundEffect('draw')
    }
    if (state.players.some((player) => player.block !== (priorPlayers.get(player.id)?.block ?? player.block))) {
      playSoundEffect('block')
    }
  }, [animateOpeningHand, authoritativeConnected, authoritativeRestoration, state, viewerId])
}

/** Actors that crossed from alive to dead during this mounted combat. */
function useFalling(
  state: CombatState,
  authoritativeRestoration?: number,
  authoritativeConnected?: boolean,
): Set<string> {
  const previous = useRef(new Map<string, boolean>())
  const previousRestoration = useRef(authoritativeRestoration)
  const previousConnected = useRef(authoritativeConnected)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [falling, setFalling] = useState<Set<string>>(new Set())

  useEffect(() => {
    const now = new Map<string, boolean>()
    const refreshed = (authoritativeRestoration !== undefined && authoritativeRestoration !== previousRestoration.current) ||
      authoritativeConnected === false || previousConnected.current === false
    previousRestoration.current = authoritativeRestoration
    previousConnected.current = authoritativeConnected
    for (const entity of [...state.players, ...state.enemies]) {
      const id = 'uid' in entity ? entity.uid : entity.id
      now.set(id, entity.dead)
      if (refreshed) continue
      if (previous.current.get(id) !== false || !entity.dead) continue
      setFalling((current) => new Set(current).add(id))
      const prior = timers.current.get(id)
      if (prior) clearTimeout(prior)
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id)
        setFalling((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      }, 860))
    }
    previous.current = now
    if (!refreshed) return
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setFalling((current) => current.size === 0 ? current : new Set())
  }, [authoritativeConnected, authoritativeRestoration, state])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
  }, [])

  return falling
}

export function CombatScreen({
  state,
  viewerId,
  onChange,
  onAction,
  autoAdvance = true,
  courierAvailable = false,
  mutationsEnabled = true,
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
  partyStartTurnDiscard,
  cardPreview,
  authoritativeVersion,
  authoritativeRefresh,
  authoritativeRestoration,
  authoritativeConnected,
  animateOpeningHand = authoritativeVersion === undefined,
}: CombatScreenProps) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [miracleOnCard, setMiracleOnCard] = useState(false)
  const [spendingShiv, setSpendingShiv] = useState(false)
  const [pendingPotion, setPendingPotion] = useState<string | null>(null)
  const [pendingPowerUid, setPendingPowerUid] = useState<string | null>(null)
  const [autoAdvanceRetry, setAutoAdvanceRetry] = useState(0)
  const [potionShivEnemyUids, setPotionShivEnemyUids] = useState<string[]>([])
  const [potionOverflowRequired, setPotionOverflowRequired] = useState(0)
  const [potionCardUids, setPotionCardUids] = useState<string[]>([])
  const [relicCardUids, setRelicCardUids] = useState<string[]>([])
  const [relicShivEnemyUids, setRelicShivEnemyUids] = useState<string[]>([])
  const [usingPotion, setUsingPotion] = useState(false)
  const [usingPower, setUsingPower] = useState(false)
  const [usingTrigger, setUsingTrigger] = useState(false)
  const [usingCard, setUsingCard] = useState(false)
  const [discardTops, setDiscardTops] = useState<Record<string, string>>({})
  const [retainedCards, setRetainedCards] = useState<Record<string, string[]>>({})
  const [discardOrders, setDiscardOrders] = useState<DiscardOrders>({})
  const [endTurnOrder, setEndTurnOrder] = useState<string[]>([])
  const [endTurnError, setEndTurnError] = useState('')
  const [endTurnOrderOpen, setEndTurnOrderOpen] = useState(false)
  const [startTurnOrder, setStartTurnOrder] = useState<string[]>([])
  const [startTurnScryOrder, setStartTurnScryOrder] = useState<string[]>([])
  const [startTurnEnemyTargets, setStartTurnEnemyTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnPlayerTargets, setStartTurnPlayerTargets] = useState<Record<string, string | undefined>>({})
  const [startTurnTargets, setStartTurnTargets] = useState<Record<string, (string | null | undefined)[]>>({})
  const [startTurnEvokeSlots, setStartTurnEvokeSlots] = useState<Record<string, number[]>>({})
  const [startTurnEvokeTargets, setStartTurnEvokeTargets] = useState<
    Record<string, (string | null | undefined)[]>
  >({})
  const [startTurnScryPicked, setStartTurnScryPicked] = useState<string[]>([])
  const [resolvingStartTurnScry, setResolvingStartTurnScry] = useState(false)
  const [resolvingStartTurnDiscard, setResolvingStartTurnDiscard] = useState(false)
  const [stageScale, setStageScale] = useState(1)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const choiceDialogRef = useRef<HTMLDialogElement | null>(null)
  const itemDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnScryDialogRef = useRef<HTMLDialogElement | null>(null)
  const startTurnDiscardDialogRef = useRef<HTMLDialogElement | null>(null)
  const viewerRowRef = useRef<HTMLDivElement | null>(null)
  const followViewerRow = useRef(true)
  const programmaticScroll = useRef<{ left: number; top: number } | null>(null)
  const manualBoardScroll = useRef(false)
  const potionActionPending = useRef(false)
  const powerActionPending = useRef(false)
  const cardActionPending = useRef(false)
  const unknownPotionAction = useRef<UnknownPotionAction | null>(null)
  const unknownPowerAction = useRef<UnknownPowerAction | null>(null)
  const unknownCardAction = useRef<UnknownCardAction | null>(null)
  const armedCardFlight = useRef<CardInstance | null>(null)
  const motionBaseline = useRef<MotionSnapshot | null>(null)
  const motionRestoration = useRef(authoritativeRestoration)
  const motionConnected = useRef(authoritativeConnected)
  const motionViewer = useRef(viewerId)
  const motionTimers = useRef(new Map<MotionKey | 'flight', ReturnType<typeof setTimeout>>())
  const flightBeat = useRef(0)
  const [drawnCards, setDrawnCards] = useState<Set<string>>(new Set())
  const [cardFlight, setCardFlight] = useState<CardFlight | null>(null)
  const [motionActive, setMotionActive] = useState<Set<MotionKey>>(new Set())
  const [motionBeats, setMotionBeats] = useState<Record<MotionKey, number>>({
    energy: 0,
    draw: 0,
    discard: 0,
    exhaust: 0,
  })
  const forcedAutoAttempt = useRef<string | null>(null)
  const viewer = state.players.find((player) => player.id === viewerId)
  const viewerHasSozu = viewer?.relics.some((relic) => relic.defId === 'sozu') ?? false
  const pendingTrigger = pendingTriggerAbility(state)
  const forcedCard = state.startTurnProgress?.forcedCard
  const distilled = state.pendingDistilled
  const relicScry = state.pendingRelicScry
  const activeStartTurnScry = partyStartTurnScry ?? (!onAction ? startTurnScryPreview(state) : undefined)
  const activeStartTurnDiscard = partyStartTurnDiscard ?? (!onAction ? startTurnDiscardPreview(state) : undefined)
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
    `${ability.players?.map((player) => player.id).join(',') ?? ''}:` +
    `${ability.evokeChoice?.options.map((option) => `${option.slot}:${option.orb}`).join(',') ?? ''}`).join('\0')

  const { struck, beats, damage } = useStruck(state, authoritativeRestoration, authoritativeConnected)
  const falling = useFalling(state, authoritativeRestoration, authoritativeConnected)
  useCombatSoundEffects(state, viewerId, animateOpeningHand, authoritativeRestoration, authoritativeConnected)

  // Animate only changes witnessed while this combat is live. A reconnect or
  // restored snapshot is a baseline, never a replay of private cards the
  // viewer did not just draw or actions that happened while away. This runs
  // before paint so a new hand never flashes in its settled position first.
  useLayoutEffect(() => {
    if (!viewer) return
    const next: MotionSnapshot = {
      hand: viewer.hand,
      energy: viewer.energy,
      draw: drawCount ?? viewer.draw.length,
      discard: viewer.discard.length,
      exhaust: viewer.exhaust.length,
    }
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== motionRestoration.current) ||
      authoritativeConnected === false || motionConnected.current === false || motionViewer.current !== viewerId
    motionRestoration.current = authoritativeRestoration
    motionConnected.current = authoritativeConnected
    motionViewer.current = viewerId
    const before = motionBaseline.current
    motionBaseline.current = next

    if (!before) {
      if (animateOpeningHand && next.hand.length > 0) {
        setDrawnCards(new Set(next.hand.map((card) => card.uid)))
      }
      return
    }

    if (restored) {
      armedCardFlight.current = null
      for (const timer of motionTimers.current.values()) clearTimeout(timer)
      motionTimers.current.clear()
      setDrawnCards((current) => current.size === 0 ? current : new Set())
      setCardFlight(null)
      setMotionActive((current) => current.size === 0 ? current : new Set())
      return
    }

    const arrivals = drawnCardUids(before.hand, next.hand)
    if (arrivals.length > 0) {
      setDrawnCards((current) => new Set([...current, ...arrivals]))
    }

    const armed = armedCardFlight.current
    if (armed && before.hand.some((card) => card.uid === armed.uid) &&
      !next.hand.some((card) => card.uid === armed.uid)) {
      flightBeat.current += 1
      setCardFlight({
        beat: flightBeat.current,
        card: armed,
        destination: cardMotionDestination(
          armed.uid,
          viewer,
          faceOf(cardDef(armed.defId), armed.upgraded).toDrawTop === true,
        ),
      })
      armedCardFlight.current = null
      const prior = motionTimers.current.get('flight')
      if (prior) clearTimeout(prior)
      motionTimers.current.set('flight', setTimeout(() => {
        motionTimers.current.delete('flight')
        setCardFlight(null)
      }, 680))
    } else if (state.phase !== 'player' && state.phase !== 'copy') {
      armedCardFlight.current = null
    }

    const changed: MotionKey[] = []
    if (before.energy !== next.energy) changed.push('energy')
    if (before.draw !== next.draw) changed.push('draw')
    if (before.discard !== next.discard) changed.push('discard')
    if (before.exhaust !== next.exhaust) changed.push('exhaust')
    if (changed.length > 0) {
      setMotionBeats((current) => {
        const updated = { ...current }
        for (const key of changed) updated[key] += 1
        return updated
      })
      setMotionActive((current) => new Set([...current, ...changed]))
      for (const key of changed) {
        const prior = motionTimers.current.get(key)
        if (prior) clearTimeout(prior)
        motionTimers.current.set(key, setTimeout(() => {
          motionTimers.current.delete(key)
          setMotionActive((current) => {
            const updated = new Set(current)
            updated.delete(key)
            return updated
          })
        }, 420))
      }
    }
  }, [animateOpeningHand, authoritativeConnected, authoritativeRestoration, drawCount, state, viewer])

  // Keep this timer in its own effect so React development Strict Mode can
  // clean up and restart it without leaving the animation class stuck on.
  useEffect(() => {
    if (drawnCards.size === 0) return undefined
    const timer = setTimeout(
      () => setDrawnCards(new Set()),
      620 + Math.max(0, (viewer?.hand.length ?? 1) - 1) * 42,
    )
    return () => clearTimeout(timer)
  }, [drawnCards, viewer?.hand.length])

  useEffect(() => () => {
    for (const timer of motionTimers.current.values()) clearTimeout(timer)
  }, [])

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
      if (shouldDisarmCardFlight(!card.copy, cardCommitted === true)) armedCardFlight.current = null
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
    programmaticScroll.current = board ? { left: board.scrollLeft, top: board.scrollTop } : null
  }

  // Drop stale targeting when the phase, seat, or mandatory trigger changes.
  useEffect(() => {
    // Entering copy has its own effect below that replaces the parent card's
    // pending UI. Do not race that replacement with a second clear.
    if (!pendingUiSurvivesContext(state.phase, state.pendingCardCopy?.playerId, viewerId)) setPending(null)
    setMiracleOnCard(false)
    setSpendingShiv(false)
    setPendingPotion(null)
    setPendingPowerUid(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
  }, [state.phase, state.pendingCardCopy?.playerId, viewerId, pendingTrigger?.id])

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

  // Only the coordinator can act on the order, so only they are shown it
  // unasked: everyone else keeps the battle log this panel would cover — and
  // keeps a panel they opened themselves, so this only ever opens.
  useEffect(() => {
    if (orderingStage && viewerId === endTurnCoordinatorId) setEndTurnOrderOpen(true)
  }, [orderingStage, viewerId, endTurnCoordinatorId])

  // The panel is a per-turn tray: leaving the player phase closes it again so
  // the next turn starts from the collapsed default.
  useEffect(() => {
    if (state.phase !== 'player') setEndTurnOrderOpen(false)
  }, [state.phase])

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

  // A chosen Distilled Chaos card can still need a board target. Keeping the
  // reveal modal open makes the whole board inert and strands that card.
  const visibleDistilled = forcedCard || state.pendingCardCopy || pendingTrigger ? undefined : distilled
  const itemModalOpen = ['liquid_memories', 'purity_potion', 'entropic_brew'].includes(pendingPotion ?? '') ||
    Boolean(relicScry) || Boolean(visibleDistilled)
  useEffect(() => {
    const dialog = itemDialogRef.current
    if (itemModalOpen) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [itemModalOpen, pendingPotion, relicScry?.playerId, visibleDistilled?.playerId])

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

  useEffect(() => {
    setResolvingStartTurnDiscard(false)
    const dialog = startTurnDiscardDialogRef.current
    const owned = activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards !== null
    if (owned) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) dialog.close()
  }, [activeStartTurnDiscard?.playerId, activeStartTurnDiscard?.sourceId,
    activeStartTurnDiscard?.cards, viewerId])

  async function finishStartTurnDiscard(card: CardInstance) {
    if (!activeStartTurnDiscard || activeStartTurnDiscard.playerId !== viewerId || resolvingStartTurnDiscard) return
    setResolvingStartTurnDiscard(true)
    if (onAction) {
      await onAction({
        kind: 'resolveStartTurnDiscard', sourceId: activeStartTurnDiscard.sourceId, discardUid: card.uid,
      })
      setResolvingStartTurnDiscard(false)
      return
    }
    onChange?.(resolveStartTurnDiscard(state, viewerId, activeStartTurnDiscard.sourceId, card.uid))
    setResolvingStartTurnDiscard(false)
  }

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
    if (pendingPotion === 'entropic_brew' && viewerHasSozu) {
      setPendingPotion(null)
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
  }, [state, viewer, viewerHasSozu, pendingPotion, potionOverflowRequired])

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
      const selectedMode = current.mode == null ? undefined : def.modes?.[current.mode]
      const selectedEnemyChoices = cardEnemyChoiceCount(def, current.mode ?? undefined)
      const mode = selectedMode?.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        selectedEnemyChoices > alive.size ? null : current.mode
      const enemyChoices = cardEnemyChoiceCount(def, mode ?? undefined)
      const playerChoices = cardPlayerChoiceCount(def, mode ?? undefined)
      const enemyUid = current.enemyUid && alive.has(current.enemyUid) ? current.enemyUid : null
      const enemyUids = mode === current.mode ? current.enemyUids.filter((uid) => alive.has(uid)) : []
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
      const needsEnemy = cardNeedsEnemy(def, viewer, false, current.effectEnergy ?? undefined) || spentShivs > 0 ||
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
        !nextEvokeChoice(def, viewer, evokeSlots, current.mode ?? undefined, current.effectEnergy ?? 0) &&
        !evokeEnemyUids.some((target) => target === undefined)) return null
      if (
        overflowShivs === current.overflowShivs &&
        spentShivs === current.spentShivs &&
        enemyUid === current.enemyUid &&
        mode === current.mode &&
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
        mode,
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
      setStartTurnPlayerTargets({})
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
    setStartTurnPlayerTargets(Object.fromEntries(baseStartAbilities.map((ability) => [
      ability.id,
      ability.players?.length === 1 ? ability.players[0]!.id : undefined,
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
        !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain).map((card) => card.uid) ?? [],
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
  const endTurnRef = useRef<HTMLButtonElement | null>(null)
  // The battle log records what the enemy did, but it lives in a collapsed
  // <details> with no live region, so a screen-reader player was never told —
  // they had to go and look. Announce the lines added while the board was the
  // enemy's, once, when it hands back. Not the player's own turn: those lines
  // are the direct result of their own keypress and announcing them would be
  // chatter. A reactive trigger the player resolves DURING the enemy phase does
  // land in this report — the UI for those is not phase-gated — which reads as
  // useful context rather than noise.
  const enemyTurnMark = useRef<number | null>(null)
  const [enemyReport, setEnemyReport] = useState('')

  useEffect(() => {
    if (state.phase === 'enemy') {
      if (enemyTurnMark.current === null) {
        enemyTurnMark.current = state.log.length
        // Cleared on the way IN, not just written on the way out. A live region
        // announces on DOM mutation, and two enemy turns often produce a
        // byte-identical line — "Cultist gained 1 Strength" every single turn —
        // so re-setting the same string is an `Object.is` bail, no mutation, and
        // silence from the second turn onward. Emptying it first guarantees the
        // text really changes when the report lands.
        setEnemyReport('')
      }
      return
    }
    if (enemyTurnMark.current === null) return
    const added = state.log.slice(enemyTurnMark.current)
    enemyTurnMark.current = null
    if (added.length > 0) setEnemyReport(added.join('. '))
  }, [state.phase, state.log])

  // Focus is dropped to <body> when the enemy's turn replaces the board, so a
  // keyboard player restarted their Tab walk from the page header every round.
  // Put them back on End turn — only when focus is genuinely nowhere, so this
  // can never steal it from something they deliberately moved to.
  //
  // Gated on where the phase came FROM, not just on arriving at `player`.
  // `start -> player` also lands here: clicking "Resolve start of turn" unmounts
  // that button, focus falls to <body>, and an ungated restore parked it on End
  // turn — the most destructive key on the screen — where the next Space or
  // Enter would end the turn the player had only just started. With a pointer
  // there is no focus ring, so nothing warns them. `copy -> resumePhase` is the
  // same shape.
  const phaseBefore = useRef(state.phase)
  useEffect(() => {
    const cameFromEnemyTurn = phaseBefore.current === 'enemy' || phaseBefore.current === 'roundEnd'
    phaseBefore.current = state.phase
    if (!cameFromEnemyTurn) return
    if (state.phase !== 'player') return
    if (document.activeElement && document.activeElement !== document.body) return
    // `preventScroll`, because this is RESTORING focus the board took away, not
    // navigating to it. Without it the browser scrolls End turn into view and
    // drags the hand scroller with it — which the fanned-card checks catch.
    endTurnRef.current?.focus({ preventScroll: true })
  }, [state.phase])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0
  }, [state.log.length])
  const bosses = state.enemies.filter((enemy) => enemy.isBoss)
  const stageEnemies = state.enemies.filter((enemy) => !enemy.isBoss)
  const stageCount = state.players.length + state.enemies.length
  const stageGap = STAGE_GAP_REM * stageScale
  const stageLayoutKey = state.enemies.map((enemy) => `${enemy.uid}:${enemy.row}:${enemy.isBoss}:${enemy.dead}`).join('|')

  useLayoutEffect(() => {
    const board = boardRef.current
    if (!board) return
    const fit = () => {
      if (board.clientWidth === 0) return
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setStageScale(stageScaleFor(stageCount, board.clientWidth, rem))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(board)
    return () => observer.disconnect()
  }, [stageCount])

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
  }, [viewerId, state.turn, state.phase, stageLayoutKey])

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
        programmaticScroll.current !== null &&
        Math.abs(board.scrollLeft - programmaticScroll.current.left) < 1 &&
        Math.abs(board.scrollTop - programmaticScroll.current.top) < 1
      ) {
        programmaticScroll.current = null
        return
      }
      programmaticScroll.current = null
      if (manualBoardScroll.current) {
        manualBoardScroll.current = false
        followViewerRow.current = false
      }
    }
    const armScroll = () => { manualBoardScroll.current = true }
    const armKeyboardScroll = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) armScroll()
    }
    const armScrollbar = (event: PointerEvent) => {
      if (event.target === board) armScroll()
    }
    const releasePointer = () => requestAnimationFrame(() => { manualBoardScroll.current = false })
    board.addEventListener('wheel', armScroll, { passive: true })
    board.addEventListener('pointerdown', armScrollbar)
    board.addEventListener('pointerup', releasePointer)
    board.addEventListener('keydown', armKeyboardScroll)
    board.addEventListener('scroll', inspectElsewhere, { passive: true })
    return () => {
      board.removeEventListener('wheel', armScroll)
      board.removeEventListener('pointerdown', armScrollbar)
      board.removeEventListener('pointerup', releasePointer)
      board.removeEventListener('keydown', armKeyboardScroll)
      board.removeEventListener('scroll', inspectElsewhere)
    }
  }, [viewerId])

  // And again whenever the desktop window changes shape. The scroll position
  // is measured in pixels against the old layout.
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
  const pendingPotionNeedsCards = pendingPotion === 'liquid_memories' || pendingPotion === 'purity_potion'
  const pendingPower = pendingPowerUid
    ? viewer.powers.find((power) => power.uid === pendingPowerUid)
    : undefined
  const pendingPowerDef = pendingPower ? faceOf(cardDef(pendingPower.defId), pendingPower.upgraded) : null
  const pendingPotionOverflow = potionOverflowRequired
  const livingPlayers = state.players.filter((player) => !player.dead)
  const confirmedDiscards = decidedPlayerIds
    ? livingPlayers.filter((player) => decidedPlayerIds.includes(player.id)).length
    : livingPlayers.filter((player) => discardOrders[player.id]).length
  // Online only: hotseat has no per-seat readiness, so one click ends the turn
  // for the table and a counter there would sit at 0 until it vanished.
  const endTurnCount = decidedPlayerIds && livingPlayers.length > 1
    ? `${confirmedDiscards}/${livingPlayers.length}`
    : null
  const discardableHand = viewer.hand.filter((card) =>
    !card.endTurnProtected && !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain)
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
  const endTurnNeedsChoice = abilities.length > 1 || abilities.some((ability) => (ability.targets?.length ?? 0) > 1)
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
    targetPlayerId: startTurnPlayerTargets[id],
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
      if (ability.players && startTurnPlayerTargets[ability.id] === undefined) {
        return [{ kind: 'player', ability }]
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
  const pendingStartPlayer = pendingStartChoice?.kind === 'player' ? pendingStartChoice.ability : undefined
  const pendingStartShiv = pendingStartChoice?.kind === 'shiv' ? pendingStartChoice : undefined
  const pendingStartEvokeTarget = pendingStartChoice?.kind === 'evokeTarget' ? pendingStartChoice : undefined
  const pendingStartEvoke = pendingStartChoice?.kind === 'evoke' ? pendingStartChoice.ability : undefined
  const pendingStartEvokeRows = pendingStartEvokeTarget?.ability.evokeTargets?.flatMap((target) => {
    const row = lightningRowFromTarget(target.uid)
    return row === null ? [] : [{ row, uid: target.uid }]
  }) ?? []
  const startTurnReady = orderedStartAbilities.length === baseStartAbilities.length &&
    !pendingStartEnemy && !pendingStartPlayer && !pendingStartShiv && !pendingStartEvokeTarget && !pendingStartEvoke
  const meaningfulStartTurnChoice = startTurnNeedsChoice(state)
  const isStartTurnEnemyTarget = (enemyUid: string) =>
    Boolean(pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid) &&
      startEnemyChoiceAvailable(enemyUid)) ||
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
    setStartTurnPlayerTargets(Object.fromEntries(plan.map((ability) => [
      ability.id,
      ability.players?.length === 1 ? ability.players[0]!.id : undefined,
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
    if (!startEnemyChoiceAvailable(enemyUid)) return
    setStartTurnEnemyTargets({ ...startTurnEnemyTargets, [pendingStartEnemy.id]: enemyUid })
  }

  function startEnemyChoiceAvailable(enemyUid: string) {
    if (!pendingStartEnemy?.targets?.some((target) => target.uid === enemyUid)) return false
    if (!pendingStartEnemy.id.startsWith('facing:')) return true
    return facingChoicesAreValid(state, startChoiceDrafts.map((choice) =>
      choice.id === pendingStartEnemy.id ? { ...choice, enemyUid } : choice))
  }

  function chooseStartTurnPlayer(playerId: string) {
    if (!pendingStartPlayer?.players?.some((player) => player.id === playerId) || !canResolveStartTurn) return
    setStartTurnPlayerTargets({ ...startTurnPlayerTargets, [pendingStartPlayer.id]: playerId })
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
      targetPlayerId: startTurnPlayerTargets[ability.id],
      shivEnemyUids: (startTurnTargets[ability.id] ?? []).map((uid) => uid ?? null),
      evokeSlots: [...(startTurnEvokeSlots[ability.id] ?? [])],
      evokeEnemyUids: (startTurnEvokeTargets[ability.id] ?? []).map((uid) => uid ?? null),
    }))
    if (onAction) onAction({ kind: 'resolveStartTurn', choices })
    else onChange?.(resolveStartPlayerTurn(state, choices))
  }

  // Resolve the engine's deterministic default plan; keep every meaningful
  // order, target, overflow, or Orb decision manual.
  useEffect(() => {
    if (!autoAdvance || state.phase !== 'start' || !canResolveStartTurn || meaningfulStartTurnChoice ||
      baseStartTurnScries.length > 0 || activeStartTurnScry ||
      activeStartTurnDiscard || pendingTrigger || forcedCard) return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const choices = defaultStartTurnChoices(state)
      if (onAction) {
        const outcome = await onAction({ kind: 'resolveStartTurn', choices })
        if (!cancelled && outcome && (outcome.status === 'refused' || outcome.status === 'unknown' ||
          outcome.status === 'reconciled' && outcome.snapshot?.run?.combat?.phase === 'start' &&
          outcome.snapshot.run.combat.turn === state.turn)) setAutoAdvanceRetry((attempt) => attempt + 1)
      } else onChange?.(resolveStartPlayerTurn(state, choices))
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, state.phase, state.turn, canResolveStartTurn,
    meaningfulStartTurnChoice, baseStartTurnScries.length, activeStartTurnScry,
    activeStartTurnDiscard, pendingTrigger, forcedCard])

  const weakByActor = [
    ...state.players.map((player) => [`player:${player.id}`, player.weak] as const),
    ...state.enemies.map((enemy) => [`enemy:${enemy.uid}`, enemy.weak] as const),
  ]
  const previousWeakByActor = useRef(new Map(weakByActor))
  const previousWeakRestoration = useRef(authoritativeRestoration)
  const previousWeakConnected = useRef(authoritativeConnected)
  useEffect(() => {
    const restored = (authoritativeRestoration !== undefined &&
      authoritativeRestoration !== previousWeakRestoration.current) ||
      authoritativeConnected === false || previousWeakConnected.current === false
    previousWeakRestoration.current = authoritativeRestoration
    previousWeakConnected.current = authoritativeConnected
    if (!restored && weakByActor.some(([id, weak]) => weak > (previousWeakByActor.current.get(id) ?? 0))) {
      playSoundEffect('weak')
    }
    previousWeakByActor.current = new Map(weakByActor)
  }, [authoritativeConnected, authoritativeRestoration, state.players, state.enemies])

  useEffect(() => {
    if (!autoAdvance || state.phase !== 'enemy' && state.phase !== 'roundEnd') return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const shouldRetry = (outcome: ActionOutcome | void) => outcome && (
        outcome.status === 'refused' || outcome.status === 'unknown' ||
        outcome.status === 'reconciled' &&
          outcome.snapshot?.run?.combat?.phase === state.phase &&
          outcome.snapshot.run.combat.turn === state.turn
      )
      if (state.phase === 'enemy') {
        if (onAction) {
          const outcome = await onAction({ kind: 'resolveEnemies' })
          if (!cancelled && shouldRetry(outcome)) {
            setAutoAdvanceRetry((attempt) => attempt + 1)
          }
        }
        else onChange?.(enemyTurn(state))
      } else if (onAction) {
        const outcome = await onAction({ kind: 'startTurn' })
        if (!cancelled && shouldRetry(outcome)) {
          setAutoAdvanceRetry((attempt) => attempt + 1)
        }
      } else onChange?.(startPlayerTurnWithChoices(state))
    }, 450)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoAdvance, autoAdvanceRetry, authoritativeRefresh, state.phase, state.turn])

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
        if (viewer.id === endTurnCoordinatorId) {
          // A refusal is normally fixed inside the order list, so reopen it even
          // if the coordinator collapsed it while the party was ordering. One
          // that lands after the turn moved on must not pry a later turn's tray
          // open, so this has to still be the same turn.
          const turn = state.turn
          const reopen = (outcome: ActionOutcome | void) => {
            if (outcome?.status === 'refused' &&
              stateRef.current.phase === 'player' && stateRef.current.turn === turn) setEndTurnOrderOpen(true)
          }
          void Promise.resolve(onAction?.({ kind: 'resolveEndTurn', abilityOrder: order }))
            .then(reopen, () => {})
        }
      } else if (onAction) onAction({ kind: 'endTurn' })
      else {
        const next = beginEndPlayerTurn(state, order)
        if (next === state) {
          setEndTurnError(STALE_END_TURN_ORDER)
          setEndTurnOrderOpen(true)
        }
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

  // In local solo all information is present, so a turn with literally no
  // card, token, potion, Power, or relic action can safely collapse. Online
  // hands are private and shared turn order is meaningful, so clients never
  // guess on behalf of the party.
  const viewerHasLegalAction = viewer.hand.some((card) => canAfford(state, viewer, card, false, drawCount)) ||
    viewer.shivs > 0 || viewer.miracles > 0 && viewer.energy < CAPS.energy && (
      viewer.relics.some((relic) => relic.defId === 'ice_cream') ||
      viewer.hand.some((card) => canAfford(state, viewer, card, true, drawCount))) ||
    viewer.potions.some((potionId) => canActivatePotion(state, viewer, potionId)) ||
    viewer.powers.some((power) => Boolean(faceOf(cardDef(power.defId), power.upgraded).activeAbility) &&
      !powerAbilityUsed(state, viewer.id, power.uid)) ||
    viewer.relics.some((_, relicIndex) => canActivateRelic(state, viewer, relicIndex)) || courierAvailable
  useEffect(() => {
    if (onAction || !autoAdvance || state.players.length !== 1 || state.phase !== 'player' ||
      viewer.dead || viewerHasLegalAction || forcedCard || distilled || pending || pendingTrigger || orderingStage ||
      endTurnNeedsChoice) return undefined
    const timer = window.setTimeout(finishTurn, 450)
    return () => window.clearTimeout(timer)
  }, [autoAdvance, state.phase, state.turn, state.players.length, viewer.dead, viewerHasLegalAction,
    forcedCard, distilled, pending, pendingTrigger, orderingStage, endTurnNeedsChoice])

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
    setMiracleOnCard(false)
    setPendingPotion(null)
    setPotionShivEnemyUids([])
    setPotionOverflowRequired(0)
    setPotionCardUids([])
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

  function cancelPotionChoice() {
    setPendingPotion(null)
    setPotionCardUids([])
  }

  function useRelic(relicIndex: number, context: RelicContext = {}) {
    const result = activateRelic(state, viewer!.id, relicIndex, context)
    if (result === state) return
    setRelicCardUids([])
    setRelicShivEnemyUids([])
    if (onAction) void onAction({ kind: 'activateRelic', relicIndex, ...context })
    else onChange?.(result)
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

  function resolveTrigger(enemyRow?: number, enemyUid?: string, targetPlayerId?: string) {
    const trigger = pendingTrigger
    if (usingTrigger || !trigger || trigger.playerId !== viewer?.id) return
    const result = resolvePendingTrigger(state, viewer!.id, trigger.id, enemyRow, enemyUid, targetPlayerId)
    if (result === state) return
    if (!onAction) {
      onChange?.(result)
      return
    }
    setUsingTrigger(true)
    Promise.resolve(onAction({
      kind: 'resolveTrigger', triggerId: trigger.id, enemyRow, enemyUid, targetPlayerId, preflight: true,
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
    ? cardNeedsEnemy(pendingDef.modes && pending?.mode != null
      ? { ...pendingDef, modes: undefined, effects: pendingDef.modes[pending.mode]?.effects ?? [] }
      : pendingDef, viewer, false, pending?.effectEnergy ?? undefined)
    : false
  const pendingEvokeChoice = pendingDef && pending
    ? nextEvokeChoice(pendingDef, viewer, pending.evokeSlots, pending.mode ?? undefined, pending.effectEnergy ?? 0)
    : null
  const pendingEvokeTarget = pending?.evokeEnemyUids.findIndex((target) => target === undefined) ?? -1
  const pendingEvokeTargetOptions = pendingDef && pending && viewer
    ? evokeTargetProgress(
      pendingDef, state, viewer, pending.evokeSlots, pending.evokeEnemyUids,
      pending.mode ?? undefined, pending.effectEnergy ?? 0,
    ).options
    : []
  const pendingEvokeTargetUids = new Set(pendingEvokeTargetOptions.map((option) => option.uid))
  const pendingEvokeUsesRows = Boolean(pending && pendingEvokeTarget >= 0 &&
    chosenEvokeOrbs(pendingDef!, viewer, pending.evokeSlots,
      pending.mode ?? undefined, pending.effectEnergy ?? 0)[pendingEvokeTarget] === 'lightning' &&
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
      recoverDiscardUids: next.choice?.kind === 'recover' ? next.picked : undefined,
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
    if (next.cardInHand) armedCardFlight.current = next.card
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
          const refreshed = refreshAttempt !== undefined && refreshRef.current !== undefined &&
            refreshRef.current > refreshAttempt
          if (committed || refreshed) {
            if (refreshed && shouldDisarmCardFlight(next.cardInHand, committed === true)) {
              armedCardFlight.current = null
            }
            unlock()
          }
          else if (refreshAttempt !== undefined) {
            unknownCardAction.current = {
              refreshAttempt,
              cardUid: next.card.uid,
              copy: !next.cardInHand,
              copiesBefore,
            }
          } else {
            if (current?.hand.some((card) => card.uid === next.card.uid)) armedCardFlight.current = null
            unlock()
          }
          return
        }
        unlock()
        if (outcome?.status === 'refused' || outcome?.status === 'reconciled') {
          const authoritative = reconciliation(outcome)
          if (!authoritative) {
            if (shouldDisarmCardFlight(next.cardInHand, false)) armedCardFlight.current = null
            return
          }
          if (next.cardInHand
            ? !authoritative.player.hand?.some((card) => card.uid === next.card.uid)
            : authoritative.combat.pendingCardCopy?.card.uid !== next.card.uid) return
          if (next.cardInHand) armedCardFlight.current = null
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
              choice: cards.length > 0 ? { kind: next.choice.kind, amount: next.choice.amount } : null,
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
          const cost = next.cardInHand ? playCost(def, authoritative.player, next.card) : 0
          const energySpent = next.cardInHand ? cost === 'X' ? null : 0
            : authoritative.combat.pendingCardCopy?.energySpent ?? 0
          const effectEnergy = next.cardInHand && def.cost === 'X' && cost !== 'X' ? cost : energySpent
          const needsEnemy = cardNeedsEnemy(def, authoritative.player, false, effectEnergy ?? undefined) || spentShivs > 0 ||
            overflowShivs > 0 || enemyChoices > 0
          const needsAlly = def.supportTarget === 'anyPlayer' &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          const needsSwitch = def.effects.some((effect) => effect.kind === 'switchRows') &&
            authoritative.combat.players.filter((player) => !player.dead).length > 1
          setMiracleOnCard(usingMiracle)
          if (needsEnemy || needsAlly || playerChoices > 0 || needsSwitch || def.modes || next.choice ||
            nextEvokeChoice(def, authoritative.player, [], undefined, effectEnergy ?? 0)) {
            setPending({
              ...next,
              energySpent,
              effectEnergy,
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
      next.mode ?? undefined, next.effectEnergy ?? 0,
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
      !nextEvokeChoice(def, viewer!, next.evokeSlots, next.mode ?? undefined, next.effectEnergy ?? 0) &&
      !next.evokeEnemyUids.some((target) => target === undefined) &&
      (def.cost !== 'X' || next.energySpent !== null) &&
      (!cardNeedsEnemy(def.modes ? { ...def, modes: undefined, effects: def.modes[next.mode!]!.effects } : def,
        viewer!, false, next.effectEnergy ?? undefined) || next.enemyUid !== null) &&
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

    // Retargeting the hand replaces an unfinished target choice; it never
    // commits the previously selected card.
    if (pending && pending.card.uid !== card.uid) setPending(null)

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
      !def.modes && !nextEvokeChoice(def, viewer!, next.evokeSlots, undefined, next.effectEnergy ?? 0)) commit(next)
  }

  // Distilled Chaos already asks which card to play. Requiring a second click
  // on the same card in hand added no decision; stage it immediately so the
  // next interaction is its real target/choice (or resolve it if it has none).
  const forcedAttemptKey = forcedCardUid ? `${state.turn}\0${forcedCardUid}` : null
  useEffect(() => {
    if (!forcedAttemptKey || !mutationsEnabled) {
      forcedAutoAttempt.current = null
      return
    }
    if (!forcedCardUid || !viewer || pending || usingCard || forcedAutoAttempt.current === forcedAttemptKey) return
    const card = viewer.hand.find((held) => held.uid === forcedCardUid)
    if (card) {
      forcedAutoAttempt.current = forcedAttemptKey
      onCardClick(card)
    }
    // The forced uid is the authoritative transition. The helpers close over
    // the matching state snapshot; depending on them would re-stage each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedAttemptKey, mutationsEnabled, usingCard])

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
      const effects = pendingDef?.modes && pending.mode != null
        ? pendingDef.modes[pending.mode]?.effects ?? []
        : pendingDef?.effects ?? []
      if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
        pending.enemyUids.includes(enemy.uid)) return
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
      pending.mode ?? undefined, pending.effectEnergy ?? 0)
    stageOrCommit({
      ...pending,
      evokeSlots,
      evokeEnemyUids: [...pending.evokeEnemyUids, ...orbs.slice(pending.evokeEnemyUids.length)
        .map((orb) => orb === 'frost' ? null : undefined)],
    })
  }

  function onModeClick(mode: number) {
    if (!pending || !pendingDef?.modes?.[mode]) return
    const effects = pendingDef.modes[mode].effects
    const selectedDef = { ...pendingDef, modes: undefined, effects }
    const enemyChoices = cardEnemyChoiceCount(pendingDef, mode)
    if (effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
      enemyChoices > state.enemies.filter((enemy) => !enemy.dead).length) return
    const playerChoices = cardPlayerChoiceCount(pendingDef, mode)
    stageOrCommit({
      ...pending, mode, enemyChoices, playerChoices, enemyUids: [],
      needsEnemy: cardNeedsEnemy(selectedDef, viewer!, false, pending.effectEnergy ?? undefined) || enemyChoices > 0,
      playerIds: state.players.filter((player) => !player.dead).length === 1
        ? Array(playerChoices).fill(viewer!.id)
        : [],
    })
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
  const independentHitPending = Boolean(independentEnemyPending && pendingDef &&
    (pendingDef.modes && pending?.mode != null
      ? pendingDef.modes[pending.mode]?.effects ?? []
      : pendingDef.effects).some((effect) => effect.kind === 'hitChoices'))
  const independentPlayerPending = Boolean(pending && pending.playerIds.length < pending.playerChoices)
  const copySource = pending?.cardInHand !== false && pendingDef?.id !== 'burst'
    ? (pendingDef?.type === 'attack' || pendingDef?.type === 'skill') && (viewer.doubledCardsThisTurn ?? 0) > 0
      ? 'Echo Form'
      : pendingDef?.type === 'attack' && (viewer.tripledAttacksThisTurn ?? 0) > 0
        ? 'Blasphemy'
        : pendingDef?.type === 'attack' && (viewer.doubledAttacksThisTurn ?? 0) > 0
          ? 'Double Tap'
          : pendingDef?.type === 'skill' && (viewer.doubledSkillsThisTurn ?? 0) > 0 ? 'Burst' : null
    : null
  const copyTarget = copySource ? ` for ${pendingDef?.name ?? 'card'} copy (${copySource})` : ''
  const activeCopy = state.pendingCardCopy
  const activeCopyName = activeCopy
    ? faceOf(cardDef(activeCopy.card.defId), activeCopy.card.upgraded).name
    : 'card'
  const copyResolutionLabel = activeCopy
    ? activeCopy.sourceNames.length > 1
      ? `${activeCopyName} copy (${activeCopy.sourceNames[0]})`
      : activeCopy.card.scryDamageBonus !== undefined
        ? `Scry-played ${activeCopyName}`
        : activeCopy.virtualOnly
          ? `${activeCopyName} copy (${activeCopy.sourceNames[0]})`
          : `original ${activeCopyName} after ${activeCopy.sourceNames[0]} copy`
    : null
  const originalTarget = pending?.cardInHand === false
    ? ` for ${copyResolutionLabel ?? pendingDef?.name ?? 'card'}`
    : ''
  const normalEnemyPrompt = pending?.hitsRow
    ? state.enemies.some((enemy) => enemy.isBoss && !enemy.dead)
      ? `Choose an enemy${originalTarget || copyTarget} — its whole row is hit, and the boss`
      : `Choose an enemy${originalTarget || copyTarget} — its whole row is hit`
    : `Choose an enemy${originalTarget || copyTarget}`
  const enemyPrompt = normalEnemyPending
    ? normalEnemyPrompt
    : independentEnemyPending
      ? `Choose ${independentHitPending ? 'damage' : 'token'} target ${(pending?.enemyUids.length ?? 0) + 1}/${pending?.enemyChoices}`
    : spentShivPending
      ? `Choose Shiv attack ${(pending?.shivEnemyUids.length ?? 0) + 1}/${pending?.spentShivs}`
    : overflowOnly
    ? `Choose overflow Shiv target ${(pending?.shivEnemyUids.length ?? 0) - (pending?.spentShivs ?? 0) + 1}/${pending?.overflowShivs}, or skip the rest`
    : normalEnemyPrompt
  const startTurnPrompt = pendingStartShiv
    ? `${pendingStartShiv.ability.label} — choose overflow Shiv ${pendingStartShiv.index + 1}/${pendingStartShiv.ability.overflowShivs}, or skip`
    : pendingStartEnemy
      ? `${pendingStartEnemy.label} — choose an enemy`
    : pendingStartPlayer
      ? `${pendingStartPlayer.label} — choose a player`
    : pendingStartEvokeTarget
      ? `${pendingStartEvokeTarget.ability.label} — choose a ${pendingStartEvokeRows.length > 0 ? 'row' : 'target'} for the Evoked Orb`
    : pendingStartEvoke?.evokeChoice
      ? `${pendingStartEvoke.label} — choose an Orb to Evoke`
    : null
  const forcedSource = forcedCard?.sourceLabel ?? (forcedCard
    ? cardDef(forcedCard.sourceCardId ?? 'mayhem').name
    : '')
  const forcedPrompt = forcedCard && !pending
    ? forcedCard.playerId === viewerId
      ? `${forcedSource} — play the drawn card for 0 Energy`
      : `Waiting for ${state.players.find((player) => player.id === forcedCard.playerId)?.name ?? 'another player'} to play ${forcedSource}'s card`
    : null
  const triggerPrompt = pendingTrigger
    ? pendingTrigger.playerId === viewer.id
      ? `${pendingTrigger.label} — choose ${pendingTrigger.targets ? 'an enemy' : pendingTrigger.players ? 'a player' : 'a row'}`
      : `Waiting for ${state.players.find((player) => player.id === pendingTrigger.playerId)?.name ?? 'another player'} to resolve ${pendingTrigger.label}`
    : null
  const beforeDrawPrompt = activeStartTurnScry && activeStartTurnScry.playerId !== viewer.id
    ? `Waiting for ${state.players.find((player) => player.id === activeStartTurnScry.playerId)?.name ?? 'another player'} to Scry before drawing`
    : null
  const prompt = triggerPrompt ?? forcedPrompt ?? beforeDrawPrompt ?? startTurnPrompt ?? (pendingPowerDef
    ? `Choose ${pendingPowerDef.target === 'row' ? 'a row' : 'an enemy'} for ${pendingPowerDef.name}`
    : pendingPotion === 'gamblers_brew'
      ? "Gambler's Brew — choose the shared die face"
    : pendingPotion === 'liquid_memories'
      ? 'Liquid Memories — choose a card from your discard pile'
    : pendingPotion === 'purity_potion'
      ? `Purity — choose up to 3 cards to Exhaust (${potionCardUids.length}/3)`
    : pendingPotion === 'entropic_brew' && !viewerHasSozu
      ? 'Entropic Brew — choose a held Potion to replace'
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
        <span key={`${state.turn}-${state.phase}`} className={`combat__phase combat__phase--${state.phase}`}>{state.phase === 'copy'
          ? `Resolve ${copyResolutionLabel ?? 'card'}`
          : PHASE_LABEL[state.phase]}</span>
        <span className="combat__actions">
          {!viewer.dead && !relicScry && (state.phase === 'player' || state.phase === 'discard' ||
            state.phase === 'start' && viewer.potions.includes('gamblers_brew')) ? (
            <>
              {state.phase === 'player' && !forcedCard && !distilled && !orderingStage && !pendingTrigger ? viewer.powers.flatMap((power) => {
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
              {(state.phase === 'player' || state.phase === 'start') && !forcedCard && !distilled && !orderingStage && !pendingTrigger ? [...new Set(viewer.potions)].flatMap((potionId) => {
                if (!canActivatePotion(state, viewer, potionId)) return []
                const potion = potionDef(potionId)
                const staged = pendingPotion === potionId
                const count = viewer.potions.filter((held) => held === potionId).length
                const shivs = gainedShivs(potion.effects)
                const needsTarget = ['gamblers_brew', 'liquid_memories', 'purity_potion'].includes(potionId) ||
                  potionId === 'entropic_brew' && !viewerHasSozu &&
                    viewer.potions.length - 1 + 2 > state.potionLimit || Boolean(potion.target) || (
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
                        setPotionCardUids([])
                      } else consumePotion(potionId)
                    }}
                  >
                    <img className="item-icon-image" src={potionIconPath(potionId)} alt="" /> {staged ? '✓ ' : ''}{potion.name}{count > 1 ? ` ×${count}` : ''}
                  </button>
                )
              }) : null}
              {state.phase === 'player' && !forcedCard && !distilled && !orderingStage && !pendingTrigger && viewer.shivs > 0 ? (
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
              {state.phase === 'player' && !forcedCard && !distilled && !orderingStage && !pendingTrigger && viewer.miracles > 0 ? (
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
              {state.phase === 'player' && !forcedCard && !distilled && endTurnNeedsChoice ? (
                <details className="end-turn-order" open={endTurnOrderOpen}
                  onToggle={(event) => setEndTurnOrderOpen(event.currentTarget.open)}>
                  <summary>End-turn order ({abilities.length})</summary>
                  {/* Every order list scrolls once a party fills it, and their
                      controls are disabled for seats that may not reorder: keep
                      them reachable by keyboard the way the combat log is. */}
                  <ol aria-label="End-turn order" tabIndex={0}>
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
              {/* The count lives on the End turn button itself. A co-op turn
                  ends when everyone says so, and being told who the table is
                  waiting on is the whole reason a second screen existed. */}
              {!forcedCard && !distilled ? <button type="button" ref={endTurnRef} className="combat__end-turn" onClick={finishTurn}
                disabled={Boolean(pending?.choiceCards) || Boolean(pendingTrigger) ||
                  (orderingStage && viewer.id !== endTurnCoordinatorId)}>
                {state.phase === 'discard'
                  ? `${discardOrders[viewer.id] ? 'Update' : 'Confirm'} ${viewer.name} (${confirmedDiscards}/${livingPlayers.length})`
                  : orderingStage
                    ? viewer.id === endTurnCoordinatorId ? 'Resolve end turn' : 'Waiting for end-turn order'
                    : endTurnCount ? `End turn ${endTurnCount}` : 'End turn'}
              </button> : null}
            </>
          ) : null}
          {state.phase === 'start' && !forcedCard && !pendingTrigger && !activeStartTurnScry &&
          orderedStartTurnScries.length > 0 ? (
            <>
              <details className="end-turn-order" open>
                <summary>Before-draw Scry order ({orderedStartTurnScries.length})</summary>
                <ol aria-label="Before-draw Scry order" tabIndex={0}>
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
                <ol aria-label="Start-of-turn order" tabIndex={0}>
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
                Object.values(startTurnPlayerTargets).some((playerId) => playerId !== undefined) ||
                Object.values(startTurnTargets).some((targets) =>
                  targets.some((target) => target !== undefined)) ||
                Object.values(startTurnEvokeSlots).some((slots) => slots.length > 0) ? (
                <button type="button" disabled={!canResolveStartTurn}
                  onClick={() => {
                    setStartTurnEnemyTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      ability.targets?.length === 1 ? ability.targets[0]!.uid : undefined,
                    ])))
                    setStartTurnPlayerTargets(Object.fromEntries(orderedStartAbilities.map((ability) => [
                      ability.id,
                      ability.players?.length === 1 ? ability.players[0]!.id : undefined,
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
              <button type="button" className="combat__end-turn" onClick={finishStartTurn}
                disabled={!startTurnReady || !canResolveStartTurn}>
                {canResolveStartTurn ? 'Resolve start of turn' : 'Waiting for start-turn order'}
              </button>
            </>
          ) : null}
        </span>
      </header>

      {over ? (
        <p className={`combat__result combat__result--${state.phase}`} role="status">
          {state.phase === 'won' ? 'Victory' : 'The party has fallen'}
        </p>
      ) : null}

      {prompt ? (
        <div className="prompt">
          <span className="prompt__text" role="status">{prompt}</span>
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
          {pendingTrigger?.playerId === viewerId ? pendingTrigger.players?.map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => resolveTrigger(undefined, undefined, player.id)}>{player.label}</button>
          )) : null}
          {pendingStartPlayer?.players?.map((player) => (
            <button type="button" className="prompt__mode" key={player.id}
              onClick={() => chooseStartTurnPlayer(player.id)}>{player.label}</button>
          ))}
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
                  onClick={() => stageOrCommit({ ...pending, energySpent: energy, effectEnergy: energy })}>
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
              disabled={!cardModeIsAvailable(pendingDef, state, viewer!, index, drawCount,
                pending.cardInHand ? pending.card.uid : undefined) ||
                (mode.effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct) &&
                  cardEnemyChoiceCount(pendingDef, index) > state.enemies.filter((enemy) => !enemy.dead).length)}
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
          {pendingPotion === 'gamblers_brew' ? Array.from({ length: 6 }, (_, index) => (
            <button type="button" className="prompt__mode" key={index + 1}
              onClick={() => consumePotion(pendingPotion, { die: index + 1 })}>
              {index + 1}
            </button>
          )) : null}
          {pending && switchChoiceReady ? (
            <button type="button" className="prompt__cancel"
              onClick={() => stageOrCommit({ ...pending, switchPlayerId: null, switchChoiceDone: true })}>
              Keep rows
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingPotionNeedsCards ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="potion-card-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="potion-card-choice-title">{pendingPotionDef!.name}</h2>
          <p>{pendingPotion === 'liquid_memories'
            ? 'Choose one discarded card to return to your hand for 0 Energy this turn.'
            : 'Choose up to three cards in your hand, then confirm.'}</p>
          <div className="distilled-choice__cards">
            {(pendingPotion === 'liquid_memories' ? viewer.discard : viewer.hand).map((card) => (
              <Card key={card.uid} card={card} selected={potionCardUids.includes(card.uid)}
                onClick={() => pendingPotion === 'liquid_memories'
                  ? consumePotion(pendingPotion, { recoverDiscardUid: card.uid })
                  : setPotionCardUids((current) => current.includes(card.uid)
                    ? current.filter((uid) => uid !== card.uid)
                    : current.length < 3 ? [...current, card.uid] : current)} />
            ))}
          </div>
          {pendingPotion === 'purity_potion' ? (
            <button type="button" className="prompt__mode"
              onClick={() => consumePotion(pendingPotion, { exhaustUids: potionCardUids })}>
              Exhaust {potionCardUids.length || 'none'}
            </button>
          ) : null}
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}

      {pendingPotion === 'entropic_brew' && !viewerHasSozu ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="entropic-choice-title"
          onCancel={(event) => {
            event.preventDefault()
            cancelPotionChoice()
          }}>
          <h2 id="entropic-choice-title">Entropic Brew</h2>
          <p>Choose one held Potion to discard, then gain two.</p>
          <div className="item-actions">
            {viewer.potions.filter((held) => held !== 'entropic_brew').map((held, index) => (
              <button type="button" key={`${held}:${index}`}
                onClick={() => consumePotion('entropic_brew', { replacePotionId: held })}>
                <img className="item-icon-image" src={potionIconPath(held)} alt="" /> Replace {potionDef(held).name}
              </button>
            ))}
          </div>
          <button type="button" className="prompt__cancel" onClick={cancelPotionChoice}>Cancel</button>
        </dialog>
      ) : null}

      {!forcedCard && !distilled && !relicScry && (state.phase === 'player' || state.phase === 'start') ? (
        <div className="relic-actions">
          <section aria-label="Relic abilities">
          {viewer.relics.flatMap((held, relicIndex) => {
            const def = relicDef(held.defId)
            const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)
            if (!canActivateRelic(state, viewer, relicIndex)) return []
            if (held.defId === 'golden_eye') return [<button type="button" key={relicIndex}
              onClick={() => useRelic(relicIndex)}>Use {def.name}</button>]
            if (held.defId === 'gambling_chip') return [<button type="button" key={relicIndex}
              onClick={() => useRelic(relicIndex)}>Reroll with {def.name}</button>]
            if (held.defId === 'blue_candle' || held.defId === 'runic_pyramid') return [<details key={relicIndex}>
              <summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card key={card.uid} card={card}
                selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                  current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) :
                    held.defId === 'blue_candle' && current.length >= 2 ? current : [...current, card.uid])} />)}</div>
              <button type="button" onClick={() => useRelic(relicIndex, { cardUids: relicCardUids })}>
                Activate
              </button>
            </details>]
            if (held.defId === 'charons_ashes') return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
              <div className="campfire__deck">{viewer.hand.map((card) => <Card key={card.uid} card={card}
                selected={relicCardUids[0] === card.uid} onClick={() => setRelicCardUids([card.uid])} />)}</div>
              {state.enemies.filter((enemy) => !enemy.dead).map((enemy) => <button type="button" key={enemy.uid}
                disabled={relicCardUids.length !== 1}
                onClick={() => useRelic(relicIndex, { cardUids: relicCardUids, enemyUid: enemy.uid })}>
                Hit {enemyLabel(state.enemies, enemy)}
              </button>)}
            </details>]
            if (held.defId === 'ninja_scroll') {
              const overflow = overflowShivCount(state, 2)
              if (overflow === 0) return [<button type="button" key={relicIndex}
                onClick={() => useRelic(relicIndex)}>Use {def.name}</button>]
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                <p>Choose {overflow} immediate Shiv target{overflow === 1 ? '' : 's'}.</p>
                {state.enemies.filter((enemy) => !enemy.dead).map((enemy) => <button type="button" key={enemy.uid}
                  onClick={() => setRelicShivEnemyUids((current) => current.length < overflow
                    ? [...current, enemy.uid] : current)}>
                  {enemyLabel(state.enemies, enemy)}
                </button>)}
                <button type="button" disabled={relicShivEnemyUids.length !== overflow}
                  onClick={() => useRelic(relicIndex, { shivEnemyUids: relicShivEnemyUids })}>
                  Throw {relicShivEnemyUids.length}/{overflow}
                </button>
                {relicShivEnemyUids.length > 0 ? <button type="button"
                  onClick={() => setRelicShivEnemyUids([])}>Clear</button> : null}
              </details>]
            }
            if (reroute) {
              const face = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 2 : null
              return [<details key={relicIndex}><summary>{def.name}</summary><p className="room-item-text">{def.text}</p>
                {state.players.filter((owner) => !owner.dead).flatMap((owner) => owner.relics.flatMap((target, targetRelicIndex) =>
                  relicAbilities(relicDef(target.defId)).flatMap((ability, targetAbilityIndex) => {
                    if (ability.trigger.kind !== 'dieRelic' || face !== null && !ability.trigger.faces.includes(face) ||
                      ['nilrys_codex', 'loaded_die'].includes(held.defId) && owner.id === viewerId &&
                      targetRelicIndex === relicIndex) return []
                    const enemies = ability.target === 'enemy' || ability.target === 'row'
                      ? state.enemies.filter((enemy) => !enemy.dead)
                      : [undefined]
                    return enemies.map((enemy) => <button type="button"
                      key={`${owner.id}:${targetRelicIndex}:${targetAbilityIndex}:${enemy?.uid ?? ''}`}
                      onClick={() => useRelic(relicIndex, {
                        targetRelicPlayerId: owner.id, targetRelicIndex, targetAbilityIndex, enemyUid: enemy?.uid,
                      })}>
                      {owner.name}: {relicDef(target.defId).name}{enemy ? ` → ${enemyLabel(state.enemies, enemy)}` : ''}
                    </button>)
                  })))}
              </details>]
            }
            return [<button type="button" key={relicIndex} onClick={() => useRelic(relicIndex)}>
              Use {def.name}{held.cubes !== undefined ? ` (${held.cubes})` : ''}
            </button>]
          })}
          </section>
        </div>
      ) : null}

      {relicScry ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="golden-eye-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="golden-eye-title">Golden Eye — Scry 3</h2>
          {relicScry.playerId === viewerId ? <>
            <p>Select any revealed cards to discard.</p>
            <div className="distilled-choice__cards">{relicScry.cards.map((card) => <Card key={card.uid} card={card}
              selected={relicCardUids.includes(card.uid)} onClick={() => setRelicCardUids((current) =>
                current.includes(card.uid) ? current.filter((uid) => uid !== card.uid) : [...current, card.uid])} />)}</div>
            <button type="button" className="prompt__mode"
              onClick={() => useRelic(relicScry.relicIndex, { scryDiscardUids: relicCardUids })}>
              Discard {relicCardUids.length || 'none'}
            </button>
          </> : <p>Waiting for {state.players.find((player) => player.id === relicScry.playerId)?.name}.</p>}
        </dialog>
      ) : null}

      {visibleDistilled ? (
        <dialog ref={itemDialogRef} className="distilled-choice" aria-labelledby="distilled-choice-title"
          onCancel={(event) => event.preventDefault()}>
          <h2 id="distilled-choice-title">Distilled Chaos</h2>
          {visibleDistilled.playerId === viewerId ? (
            <>
              <p>Choose the next revealed card to play for 0 Energy.</p>
              <div className="distilled-choice__cards">
                {visibleDistilled.cards.map((card) => (
                  <Card key={card.uid} card={card} cost={0} playable
                    onClick={() => onAction
                      ? void onAction({ kind: 'chooseDistilledCard', cardUid: card.uid })
                      : onChange?.(chooseDistilledCard(state, viewerId, card.uid))} />
                ))}
              </div>
            </>
          ) : (
            <p>Waiting for {state.players.find((player) => player.id === visibleDistilled.playerId)?.name ?? 'another player'} to choose the next card.</p>
          )}
        </dialog>
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

      {activeStartTurnDiscard?.playerId === viewerId && activeStartTurnDiscard.cards ? (
        <dialog ref={startTurnDiscardDialogRef} className="choice-modal" aria-labelledby="start-turn-discard-title"
          onCancel={(event) => event.preventDefault()}>
          <div className="choice-modal__panel">
            <h2 id="start-turn-discard-title">Tools of the Trade — discard 1 card</h2>
            <p>Choose one card from your hand. This choice is private.</p>
            <div className="choice-modal__cards">
              {activeStartTurnDiscard.cards.map((card) => (
                <Card key={card.uid} card={card} onClick={() => void finishStartTurnDiscard(card)} />
              ))}
            </div>
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
                  ? `Choose ${choiceNeeded} card${choiceNeeded === 1 ? '' : 's'} from your discard pile`
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
                    ? `Return selected card${choiceNeeded === 1 ? '' : 's'} to hand`
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} on top`
                : pending.choice.kind === 'recoverExhaust'
                  ? 'Return selected card to hand'
                : pending.choice.kind === 'search'
                  ? choiceNeeded === 0
                    ? 'Shuffle and continue'
                    : pendingDef?.effects.some((effect) => effect.kind === 'searchDrawAndPlayTwice')
                    ? 'Play selected card twice and shuffle'
                    : `Put selected card${choiceNeeded === 1 ? '' : 's'} in hand and shuffle`
                : choiceNeeded === 0 ? 'Continue' : `Discard selected card${choiceNeeded === 1 ? '' : 's'}`}
            </button>
            {pending.cardInHand &&
            (pending.choice.kind === 'recover' || pending.choice.kind === 'recoverExhaust') ? (
              <button type="button" className="prompt__cancel" onClick={() => setPending(null)}>Cancel</button>
            ) : null}
          </div>
        </dialog>
      ) : null}

      <div
        className="board"
        data-rows={rows.length}
        ref={boardRef}
        tabIndex={0}
        aria-label="Combat board"
        style={{
          '--stage-scale': stageScale,
          '--stage-width': `${stageCount * stageGap + STAGE_MARGIN_REM * stageScale}rem`,
          '--stage-gap': `${stageGap}rem`,
          '--stage-actor-width': `${stageGap - 1 * stageScale}rem`,
        } as React.CSSProperties}
      >
        {bosses.length > 0 ? (
          <div className="board__bosses">
            {bosses.map((enemy, index) => (
              <EnemyCard
                key={enemy.uid}
                enemy={enemy}
                label={enemyLabel(state.enemies, enemy)}
                die={state.die}
                struck={struck.has(enemy.uid)}
                falling={falling.has(enemy.uid)}
                hitDamage={damage.get(enemy.uid)}
                beat={beats.get(enemy.uid) ?? 0}
                stageIndex={stageEnemies.length + index}
                // A boss stands in every row, so the only reading that means
                // anything to the person looking at the screen is their own.
                defender={viewer}
                disabled={Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid))}
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
              style={{ '--stage-row': rows.indexOf(row) } as React.CSSProperties}
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
                        falling.has(occupant.id) ? 'seat--falling' : '',
                        struck.has(occupant.id) ? strikeClass('seat', beats.get(occupant.id) ?? 0) : '',
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
                      <span className="seat__portrait" aria-hidden="true">
                        <img
                          src={`/assets/combat/characters/${occupant.character}.webp`}
                          alt=""
                          onError={(event) => { event.currentTarget.style.display = 'none' }}
                        />
                      </span>
                      {struck.has(occupant.id) ? (
                        <span className="hit-vfx" key={beats.get(occupant.id)} aria-hidden="true"><strong>{damage.get(occupant.id)}</strong></span>
                      ) : null}
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
                      <OrbRow
                        orbs={occupant.character === 'defect'
                          ? occupant.orbs
                          : occupant.orbs.filter((orb) => orb !== null)}
                      />
                      <span className="seat__meta">
                      {occupant.strengthLossAtEndOfTurn > 0 ? (
                        <span className="seat__pending">
                          −{occupant.strengthLossAtEndOfTurn} Strength at end of turn
                        </span>
                      ) : null}
                      {occupant.drawLocked ? (
                        <span className="seat__pending">Cannot draw more cards this turn</span>
                      ) : null}
                      {occupant.cardPlayLocked ? (
                        <span className="seat__pending">No additional cards this turn</span>
                      ) : null}
                      {(occupant.freeAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">Swivel · next Attack costs 0 this turn</span>
                      ) : null}
                      {(occupant.doubledAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Double Tap · next {occupant.doubledAttacksThisTurn} Attack{
                            occupant.doubledAttacksThisTurn === 1 ? '' : 's'
                          } played twice
                        </span>
                      ) : null}
                      {(occupant.tripledAttacksThisTurn ?? 0) > 0 ? (
                        <span className="seat__pending">
                          Blasphemy · next {occupant.tripledAttacksThisTurn} Attack{
                            occupant.tripledAttacksThisTurn === 1 ? '' : 's'
                          } played three times
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
                      {remainingRoundHpLoss(occupant) !== undefined ? (
                        <span className="seat__pending">
                          {occupant.powers.some((power) => power.defId === 'wraith_form') ? 'Wraith Form' : 'Apparition'} · {remainingRoundHpLoss(occupant)} HP loss remaining
                        </span>
                      ) : null}
                      {occupant.potions.length > 0 ? (
                        <span className="seat__potions" title="Held potions">
                          {occupant.potions.map((id, index) => <img className="item-icon-image"
                            key={`${id}-${index}`} src={potionIconPath(id)} alt="" />)} {potionSummary(occupant)}
                        </span>
                      ) : null}
                      {occupant.stance !== 'neutral' ? (
                        <span className={`stance stance--${occupant.stance}`}>{occupant.stance}</span>
                      ) : null}
                      </span>
                    </button>
                    <div className="seat__status-strip">
                      <TokenRow
                        block={occupant.block}
                        strength={occupant.strength}
                        vulnerable={occupant.vulnerable}
                        weak={occupant.weak}
                        shivs={occupant.shivs}
                        miracles={occupant.miracles}
                        clawCubes={occupant.clawCubesGainedThisCombat}
                      />
                      <PowerRow powers={occupant.powers} />
                    </div>
                  </>
                ) : (
                  <span className="seat seat--empty">empty row</span>
                )}
              </div>
              <div className="row__enemies" data-enemies={foes.length}>
                {foes.length > 0 ? (
                  foes.map((enemy) => (
                    <EnemyCard
                      key={enemy.uid}
                      enemy={enemy}
                      label={enemyLabel(state.enemies, enemy)}
                      die={state.die}
                      struck={struck.has(enemy.uid)}
                      falling={falling.has(enemy.uid)}
                      hitDamage={damage.get(enemy.uid)}
                      beat={beats.get(enemy.uid) ?? 0}
                      stageIndex={stageEnemies.findIndex((candidate) => candidate.uid === enemy.uid)}
                      rowLabel={occupant?.name ?? `Player ${row + 1}`}
                      defender={occupant}
                      disabled={Boolean(pendingStartEnemy?.id.startsWith('facing:') && !startEnemyChoiceAvailable(enemy.uid))}
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
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <p className="visually-hidden combat__enemy-report" aria-live="polite">{enemyReport}</p>
      {state.log.length > 0 ? (
        <details className="combat-log-drawer">
          <summary>Battle log</summary>
          <ol className="combat__log" aria-label="Combat log" ref={logRef} tabIndex={0}>
            {roundLog(state.log).map((line, i) => (
              <li key={`${state.log.length - i}-${line}`}
                className={TURN_MARKER.test(line) ? 'combat__log-turn' : undefined}>{line}</li>
            ))}
          </ol>
        </details>
      ) : null}

      <footer className="hand-area">
        <div className="hand-area__stats">
          <span className={[
            'pip',
            'pip--energy',
            motionActive.has('energy') ? `motion-pulse-${motionBeats.energy % 2}` : '',
          ].filter(Boolean).join(' ')} title="Energy">
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
            <span className={[
              'pile',
              motionActive.has(kind) ? `motion-pulse-${motionBeats[kind] % 2}` : '',
            ].filter(Boolean).join(' ')} data-pile={kind} key={kind} title={top ? `${label} — ${top} on top` : label}>
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
        <div className="hand-scroll" onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaX || (event.shiftKey ? event.deltaY : 0)
        }}><div className="hand" data-count={viewer.hand.length}>
          {viewer.hand.map((card, index) => (
            <Card
              key={card.uid}
              className={drawnCards.has(card.uid) ? 'card--drawn' : undefined}
              style={{ '--deal-index': index } as React.CSSProperties}
              fan={fanOf(index, viewer.hand.length)}
              card={card}
              cost={card.uid === forcedCardUid ? 0 : playCost(faceOf(cardDef(card.defId), card.upgraded), viewer, card)}
              playable={
                !usingCard &&
                !pendingTrigger &&
                !orderingStage &&
                (!pending?.choiceCards || pending.card.uid === card.uid) &&
                ((state.phase === 'player' && !forcedCard && !distilled && !relicScry) || card.uid === forcedCardUid ||
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
        </div></div>
      </footer>
      {cardFlight ? (
        <div
          className={`card-flight card-flight--${cardFlight.destination}`}
          key={cardFlight.beat}
          aria-hidden="true"
          inert
        >
          <Card card={cardFlight.card} playable={false} />
        </div>
      ) : null}
    </div>
  )
}
