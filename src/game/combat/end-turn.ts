// End of Turn: the abilities that answer the turn ending, the discard, and the
// hand-off to the Enemy Turn.
//
// Like the Start of Turn, this phase is resumable. An ability that needs a
// target parks its progress and comes back through `resolvePendingTrigger`,
// which is the one door back in for a parked trigger whichever phase left it
// there. A discard the owner has to order privately parks in its own way and
// comes back through `endPlayerTurn` with the order attached.
import {
  clone,
  combatIsOver,
  combatRowLabel,
  combatRows,
  enemyLabel,
  findPlayer,
  lightningTargetOptions,
  livingEnemies,
  loopOrbTargets,
  parseLoopOrbTarget,
  resolveEnemyTargets,
  rowExists,
} from './board.ts'
import {
  damagePlayer,
  exhaustCards,
  flushPendingTriggers,
  losePlayerHp,
  resolveOrbAtEndOfTurn,
  resolveQueuedTriggerSource,
  resolveTriggerSource,
  settle,
  triggerEnemyDeath,
  triggerNeedsEnemyChoice,
  triggerNeedsPlayerChoice,
  triggerNeedsRowChoice,
  triggerSourceById,
  triggerSources,
} from './effects.ts'
import { forgetRetain, grantShiftBlock, loseEnemyHp } from './pieces.ts'
import {
  continueBeforeDraw,
  continueStartTurn,
  finishStartTurnDraw,
  resolveDueSummons,
  triggerTargets,
} from './start-turn.ts'
import { chooseEndTurnTarget, defaultEndTurnOrder, endTurnChoiceId, endTurnChoiceTarget } from './types.ts'
import type { CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, PendingTriggerAbility } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import { gainBlock, gainWeak } from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { discardHand } from '../piles.ts'
import type { CardInstance, Player } from '../types.ts'

function playerEndTurnAbilities(state: CombatState, player: Player): Omit<EndTurnAbility, 'playerId'>[] {
  const abilities: Omit<EndTurnAbility, 'playerId'>[] = triggerSources(player, { kind: 'endOfTurn' })
    .map((source) => ({
      id: source.id,
      label: source.name.replace(`${player.name}'s `, ''),
      targets: source.effects.some((effect) => effect.kind === 'triggerOrbEndTurn')
        ? loopOrbTargets(state, player)
        : triggerTargets(state, player, source),
    }))
  if ((player.strengthLossAtEndOfTurn ?? 0) > 0) {
    abilities.push({ id: 'strength', label: 'Lose temporary Strength' })
  }
  player.orbs.forEach((orb, slot) => {
    if (orb === 'lightning') {
      const targets = lightningTargetOptions(state, player)
      if (targets.length === 0) return
      abilities.push({
        id: `orb:${slot}`,
        label: `Lightning Orb ${slot + 1}`,
        targets,
      })
    } else if (orb === 'frost') abilities.push({ id: `orb:${slot}`, label: `Frost Orb ${slot + 1}` })
  })
  if (player.stance === 'wrath') abilities.push({ id: 'wrath', label: 'Wrath damage' })
  for (const held of player.hand) {
    const def = faceOf(cardDef(held.defId), held.upgraded)
    if ((def.handEndOfTurn?.length ?? 0) > 0 || def.ethereal) {
      abilities.push({ id: `card:${held.uid}`, label: `${def.name}${def.ethereal ? ' — Exhaust' : ''}` })
    }
  }
  return abilities
}

/** Every ability the party may interleave at end of turn (p.12). */
export function endTurnAbilities(state: CombatState): EndTurnAbility[] {
  if (state.phase !== 'player') return []
  const poison = state.enemies.flatMap((enemy) => enemy.dead || enemy.poison === 0 ? [] : [{
    id: `poison:${enemy.uid}`,
    playerId: null,
    label: `${enemyLabel(state.enemies, enemy)} — Poison`,
  }])
  const beat = state.enemies.flatMap((enemy) => enemy.dead ? [] :
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'beatOfDeath')
      ? [{ id: `beat:${enemy.uid}`, playerId: null, label: `${enemyLabel(state.enemies, enemy)} — Beat of Death` }]
      : [])
  return [
    ...poison,
    ...beat,
    ...state.players.flatMap((player) => player.dead ? [] : playerEndTurnAbilities(state, player).map((ability) => ({
      ...ability,
      id: `${player.id}/${ability.id}`,
      playerId: player.id,
      label: `${player.name} — ${ability.label}`,
    }))),
  ]
}

export function validEndTurnOrder(abilities: readonly EndTurnAbility[], order: readonly string[]): boolean {
  const expected = new Set(abilities.map((ability) => ability.id))
  const ids = order.map(endTurnChoiceId)
  return order.length === expected.size && new Set(ids).size === expected.size && order.every((choice) => {
    const ability = abilities.find((candidate) => candidate.id === endTurnChoiceId(choice))
    const target = endTurnChoiceTarget(choice)
    return ability !== undefined && (ability.targets
      ? target !== undefined && choice === chooseEndTurnTarget(ability.id, target) &&
        ability.targets.some((candidate) => candidate.uid === target)
      : target === undefined && choice === ability.id)
  })
}

/** Retargets still-unresolved single-enemy abilities after an earlier ordered effect kills their target. */
function refreshEndTurnTargets(state: CombatState, order: EndTurnOrder): EndTurnOrder {
  const abilities = endTurnAbilities(state)
  return order.map((choice) => {
    const id = endTurnChoiceId(choice)
    const target = endTurnChoiceTarget(choice)
    const ability = abilities.find((candidate) => candidate.id === id)
    if (!target || !ability?.targets || ability.targets.some((candidate) => candidate.uid === target)) return choice

    const slash = id.indexOf('/')
    const player = findPlayer(state, id.slice(0, slash))
    const localId = id.slice(slash + 1)
    const source = player && (localId.startsWith('relic:') || localId.startsWith('power:'))
      ? triggerSources(player, { kind: 'endOfTurn' }).find((candidate) => candidate.id === localId)
      : undefined
    // A row-targeting ability keeps its chosen row even when its enemy anchor died.
    if (source?.scope === 'row' && state.enemies.some((enemy) => enemy.uid === target)) return choice
    const loopTarget = source?.effects.some((effect) => effect.kind === 'triggerOrbEndTurn')
      ? parseLoopOrbTarget(target)
      : undefined
    // Loop repeats the Orb the player selected; only its enemy may change.
    const fallback = loopTarget
      ? ability.targets.find((candidate) => parseLoopOrbTarget(candidate.uid)?.slot === loopTarget.slot)
      : ability.targets[0]
    return fallback ? chooseEndTurnTarget(id, fallback.uid) : choice
  })
}

function resolveHandEndTurn(state: CombatState, player: Player, uid: string): void {
  const held = player.hand.find((card) => card.uid === uid)
  if (!held) return
  const def = faceOf(cardDef(held.defId), held.upgraded)
  for (const effect of def.handEndOfTurn ?? []) {
    if ('handSizeAtMost' in effect && effect.handSizeAtMost !== undefined &&
      player.hand.length > effect.handSizeAtMost) continue
    if (effect.kind === 'damage') {
      const block = player.block
      const outcome = damagePlayer(state, player, effect.amount)
      const lost = outcome.hpLost
      const blocked = block - player.block
      state.log = [...state.log, lost > 0
        ? `${def.name} damages ${player.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : outcome.fullyBlocked
          ? `${player.name} blocks ${def.name} (${blocked} spent)`
          : `${def.name} did no damage to ${player.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`]
    } else if (effect.kind === 'loseHp') {
      const lost = losePlayerHp(state, player, effect.amount)
      if (lost > 0) state.log = [...state.log, `${def.name}: ${player.name} loses ${lost} HP`]
    } else if (effect.kind === 'gainWeak') {
      const before = player.weak
      player.weak = gainWeak(player.weak, effect.amount)
      if (player.weak > before) {
        state.log = [...state.log, `${def.name}: ${player.name} gains ${player.weak - before} Weak`]
      }
    } else {
      const lost = Math.min(player.block, effect.amount)
      player.block -= lost
      if (lost > 0) state.log = [...state.log, `${def.name}: ${player.name} loses ${lost} Block`]
    }
    if (player.dead) {
      state.log = [...state.log, `${player.name} has fallen`]
      return
    }
  }
  if (!def.ethereal) return

  player.hand = player.hand.filter((card) => card.uid !== uid)
  const before = new Set(player.hand.map((card) => card.uid))
  exhaustCards(state, player, [held])
  // FAQ: Dark Embrace draws caused by an end-turn Ethereal Exhaust ignore
  // end-turn/Ethereal text and are not discarded during this step.
  for (const card of player.hand) if (!before.has(card.uid)) card.endTurnProtected = true
  state.log = [...state.log, `${player.name} exhausts ${def.name} (Ethereal)`]
}

function continueEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder,
): CombatState {
  const next = state
  for (let index = 0; index < order.length; index++) {
    // Earlier ordered effects may kill this ability's chosen enemy. Recompute
    // against the current board, not the board on which the order was submitted.
    const choice = refreshEndTurnTargets(next, [order[index]!])[0]!
    const id = endTurnChoiceId(choice)
    if (id.startsWith('poison:')) {
      const enemy = next.enemies.find((candidate) => candidate.uid === id.slice(7))
      if (enemy && !enemy.dead && enemy.poison > 0) {
        const outcome = loseEnemyHp(next, enemy, enemy.poison)
        const name = enemyLabel(next.enemies, enemy)
        next.log = [...next.log, `${name} loses ${outcome.hpLost} to Poison`]
        enemy.hp = outcome.hp
        if (enemy.hp === 0) {
          enemy.dead = true
          next.log = [...next.log, `${name} is dead`]
          triggerEnemyDeath(next, enemy)
        }
        if (outcome.hpLost > 0 && !combatIsOver(next) &&
          enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'shift')) {
          grantShiftBlock(next, enemy, outcome.hpLost)
        }
      }
    } else if (id.startsWith('beat:')) {
      const enemy = next.enemies.find((candidate) => candidate.uid === id.slice(5) && !candidate.dead)
      const beat = enemy && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'beatOfDeath')
      if (enemy && beat?.kind === 'beatOfDeath') {
        const amount = (enemy.abilityCubes ?? 0) * beat.damagePerCube
        for (const player of next.players.filter((candidate) => !candidate.dead)) {
          const block = player.block
          const outcome = damagePlayer(next, player, amount)
          const lost = outcome.hpLost
          const blocked = block - player.block
          next.log = [...next.log, lost > 0
            ? `${enemyLabel(next.enemies, enemy)}'s Beat of Death hit ${player.name} for ${lost}${blocked ? ` (${blocked} blocked)` : ''}`
            : outcome.fullyBlocked ? `${player.name} blocked Beat of Death` : `Beat of Death did no damage to ${player.name}`]
          if (player.dead) {
            next.log = [...next.log, `${player.name} has fallen`]
            if (combatIsOver(next)) break
          }
        }
      }
    } else {
      const slash = id.indexOf('/')
      const player = findPlayer(next, id.slice(0, slash))
      const localId = id.slice(slash + 1)
      if (!player || player.dead) continue
      if (localId.startsWith('relic:') || localId.startsWith('power:')) {
        const source = triggerSources(player, { kind: 'endOfTurn' })
          .find((candidate) => candidate.id === localId)
        const target = endTurnChoiceTarget(choice)
        const loop = source?.effects.some((effect) => effect.kind === 'triggerOrbEndTurn')
        const loopChoice = loop ? parseLoopOrbTarget(target) : undefined
        // A row is chosen when the order is submitted. Preserve that row if
        // an earlier ability kills its enemy anchor, without teaching ordinary
        // card plays that a dead enemy is a valid target.
        const selectedRow = source?.scope === 'row'
          ? next.enemies.find((enemy) => enemy.uid === target)?.row
          : undefined
        if (source && (loop
          ? !resolveTriggerSource(next, player, source, false, undefined, undefined, undefined,
            loopChoice ? [loopChoice.slot] : undefined, loopChoice ? [loopChoice.enemyUid] : undefined)
          : ((source.scope !== 'row' && triggerTargets(next, player, source) &&
            resolveEnemyTargets(next, source.scope, target ?? null).length === 0) ||
            !resolveTriggerSource(next, player, source, false, undefined, target, selectedRow)))) {
          continue
        }
      } else if (localId === 'strength') {
        const loss = Math.min(player.strength, player.strengthLossAtEndOfTurn ?? 0)
        if (loss > 0) {
          player.strength -= loss
          next.log = [...next.log, `${player.name} loses ${loss} Strength at end of turn`]
        }
        player.strengthLossAtEndOfTurn = 0
      } else if (localId.startsWith('orb:')) {
        if (!resolveOrbAtEndOfTurn(next, player, Number(localId.slice(4)), endTurnChoiceTarget(choice))) {
          continue
        }
      } else if (localId === 'wrath') {
        const outcome = damagePlayer(next, player, 1)
        next.log = [...next.log, outcome.hpLost > 0
          ? `${player.name} takes 1 from Wrath`
          : outcome.fullyBlocked
            ? `${player.name} blocks the bite of Wrath`
            : `${player.name}'s Wrath did no damage`]
        if (player.dead) next.log = [...next.log, `${player.name} has fallen`]
      } else if (localId.startsWith('card:')) {
        resolveHandEndTurn(next, player, localId.slice(5))
      }
    }
    if (combatIsOver(next)) break
    if ((next.pendingTriggers?.length ?? 0) > 0) {
      next.endTurnProgress = { order: order.slice(index + 1) }
      return settle(next)
    }
  }

  delete next.endTurnProgress
  next.phase = 'discard'
  const settled = settle(next)
  // Stopping the whole party to collect a confirmation per seat, when not one of
  // them had anything to arrange, was the clunkiest beat in the round. Skip the
  // prompt outright unless somebody's hand actually poses a question. Done here
  // rather than in the two callers so solo and online cannot drift apart.
  if (settled.phase === 'discard' && !settled.players.some(discardNeedsChoice)) {
    return endPlayerTurn(settled)
  }
  return settled
}

/**
 * Whether either face of this card reads the top of the discard pile.
 *
 * A scan of the whole face rather than a walk down `amount.bonus.when`, which is
 * the only shape the condition takes today: this decides whether a player is
 * ASKED for an order, and a card added later in some other shape would silently
 * stop being asked rather than fail loudly.
 */
function readsDiscardTop(card: CardInstance): boolean {
  const def = cardDef(card.defId)
  return JSON.stringify([faceOf(def, false), faceOf(def, true)]).includes('discardTopCosts')
}

/**
 * Whether this player's end-of-turn discard is a decision or a formality.
 *
 * Only two things make it a decision. An optional Retain, where the player picks
 * which cards stay. And the order itself — but that decides one thing only, what
 * sits on TOP of the discard pile, which nothing reads unless this player owns a
 * Claw or a Steam Barrier. So the prompt asks a Defect running Claws and stays
 * out of everybody else's way; it used to stop all four players every round to
 * collect confirmations of an arrangement that could not matter.
 *
 * AUTHORITATIVE STATE ONLY. It reads `player.draw`, which the room server
 * redacts from every client — a browser asking this about a teammate, or about
 * itself online, would get "no choice" for a deck that has a Claw in it. The
 * phase is the server's answer to this question; nothing in `src/ui/` should ask
 * it again.
 */
export function discardNeedsChoice(player: Player): boolean {
  if (player.dead) return false
  if ((player.retainCardsThisTurn ?? 0) > 0) return true
  const discarding = player.hand.filter((card) => !card.endTurnProtected && !card.retainThisTurn &&
    !faceOf(cardDef(card.defId), card.upgraded).retain)
  if (discarding.length <= 1) return false
  // Every pile, not just the hand: the card that cares may still be undrawn.
  return [player.hand, player.draw, player.discard, player.exhaust, player.powers]
    .some((pile) => pile.some(readsDiscardTop))
}

/**
 * Defensive fallback when an end-of-turn order cannot resolve despite still
 * matching the battle. Normal ordered overkill retargets or skips in-engine.
 */
export const STALE_END_TURN_ORDER =
  'An end-of-turn ability is aimed at an enemy an earlier one kills. Re-aim or reorder it under "End-turn order", then try again.'

/** Shown online when the battle moved under a published order, which the room
 *  then rebuilds: the arrangement is gone, so the advice is different. */
export const REBUILT_END_TURN_ORDER =
  'The battle changed while the party was ordering. The end-of-turn order was rebuilt — set it again under "End-turn order".'

/** Resolves end-of-turn effects in each player's chosen order, then asks for discards. */
export function beginEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder = defaultEndTurnOrder(endTurnAbilities(state)),
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const abilities = endTurnAbilities(state)
  if (!validEndTurnOrder(abilities, order)) return state
  const next = clone(state)
  for (const player of next.players) {
    if (player.block === 0 && player.relics.some((relic) => relic.defId === 'orichalcum')) {
      player.block = gainBlock(player.block, 1)
      next.log = [...next.log, `${player.name}'s Orichalcum grants 1 Block`]
    }
  }
  return continueEndPlayerTurn(next, order)
}

/** Whether an ordered discard omits only cards this player may Retain. */
export function discardOrderIsValid(player: Player, order: readonly string[]): boolean {
  const hand = new Set(player.hand.map((card) => card.uid))
  if (new Set(order).size !== order.length || order.some((uid) => !hand.has(uid))) return false
  const ordered = new Set(order)
  const optionallyRetained = player.hand.filter((card) =>
    !ordered.has(card.uid) && !card.endTurnProtected && !card.retainThisTurn &&
      !faceOf(cardDef(card.defId), card.upgraded).retain)
  return optionallyRetained.length <= (player.retainCardsThisTurn ?? 0)
}

/** End of Turn: resolve effects, then discard every hand in chosen order. */
export function endPlayerTurn(state: CombatState, discardOrders: DiscardOrders = {}): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  if (state.phase !== 'player' && state.phase !== 'discard') return state
  for (const order of Object.values(discardOrders)) {
    if (!Array.isArray(order) || order.some((uid) => typeof uid !== 'string')) return state
  }
  const prepared = state.phase === 'player' ? beginEndPlayerTurn(state) : state
  if (prepared.phase !== 'discard') return prepared
  // Validate against the hand AFTER triggers, which may have drawn or removed
  // cards. An old order leaves the state parked at the discard prompt.
  for (const player of prepared.players) {
    const order = discardOrders[player.id]
    if (!order) continue
    if (!discardOrderIsValid(player, order)) return prepared
  }
  const next = clone(prepared)
  for (const player of next.players) {
    if (player.dead) continue
    const held = player.hand.length
    const order = discardOrders[player.id]
    const ordered = new Set(order ?? player.hand.map((card) => card.uid))
    const hand = order
      ? [...order.map((uid) => player.hand.find((card) => card.uid === uid)!),
        ...player.hand.filter((card) => !ordered.has(card.uid))]
      : player.hand
    const chosenRetain = new Set(player.hand
      .filter((card) => !ordered.has(card.uid) && !card.endTurnProtected && !card.retainThisTurn &&
        !faceOf(cardDef(card.defId), card.upgraded).retain)
      .map((card) => card.uid))
    const keep = hand
      .filter((held) => chosenRetain.has(held.uid) || held.endTurnProtected || held.retainThisTurn ||
        faceOf(cardDef(held.defId), held.upgraded).retain)
      .map((held) => held.uid)
    const piles = discardHand({ ...player, hand }, keep)
    player.draw = piles.draw
    player.hand = piles.hand.map((held) => {
      const clean = forgetRetain({ ...held, endTurnProtected: undefined })
      return chosenRetain.has(held.uid) || held.retainThisTurn ||
        faceOf(cardDef(held.defId), held.upgraded).retain
        ? { ...clean, retainedLastTurn: true }
        : clean
    })
    player.discard = piles.discard.map(forgetRetain)
    const discarded = held - keep.length
    if (discarded > 0) {
      next.log = [...next.log, `${player.name} discards ${discarded} at end of turn`]
    }
    player.retainCardsThisTurn = 0
  }

  resolveDueSummons(next, 'endOfTurn')
  next.phase = 'enemy'
  return settle(next)
}

export function pendingTriggerAbility(state: CombatState): PendingTriggerAbility | undefined {
  const pending = state.pendingTriggers?.[0]
  const player = pending && findPlayer(state, pending.playerId)
  const source = player && pending ? triggerSourceById(player, pending.sourceId) : undefined
  if (!player || !source) return undefined
  return {
    id: pending.id,
    playerId: player.id,
    label: source.name,
    rows: triggerNeedsRowChoice(state, player, source)
      ? combatRows(state).map((row) => ({ row, label: combatRowLabel(state, row) }))
      : undefined,
    targets: triggerNeedsEnemyChoice(state, player, source, pending.enemyUid)
      ? livingEnemies(state).map((enemy) => ({
        uid: enemy.uid,
        label: enemyLabel(state.enemies, enemy),
      }))
      : undefined,
    players: triggerNeedsPlayerChoice(state, source)
      ? state.players.filter((candidate) => !candidate.dead).map((candidate) => ({ id: candidate.id, label: candidate.name }))
      : undefined,
  }
}

/** Resolve the oldest triggered ability before any other combat action. */
export function resolvePendingTrigger(
  state: CombatState,
  playerId: string,
  triggerId: number,
  enemyRow?: number,
  enemyUid?: string,
  targetPlayerId?: string,
): CombatState {
  const pending = state.pendingTriggers?.[0]
  if (!pending || pending.playerId !== playerId || pending.id !== triggerId) return state
  const player = findPlayer(state, playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!player || player.dead || !source) return state
  const needsRow = triggerNeedsRowChoice(state, player, source)
  const needsEnemy = triggerNeedsEnemyChoice(state, player, source, pending.enemyUid)
  const needsPlayer = triggerNeedsPlayerChoice(state, source)
  if ((needsRow && !rowExists(state, enemyRow)) || (!needsRow && enemyRow !== undefined)) return state
  if ((needsEnemy && !livingEnemies(state).some((enemy) => enemy.uid === enemyUid)) ||
    (!needsEnemy && enemyUid !== undefined)) return state
  if ((needsPlayer && !state.players.some((candidate) => !candidate.dead && candidate.id === targetPlayerId)) ||
    (!needsPlayer && targetPlayerId !== undefined)) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const queued = next.pendingTriggers.shift()!
  const liveSource = triggerSourceById(actor, queued.sourceId)!
  resolveQueuedTriggerSource(
    next,
    actor,
    liveSource,
    queued.enemyUid ?? (needsEnemy ? enemyUid : liveSource.scope === 'enemy'
      ? livingEnemies(next)[0]?.uid
      : undefined),
    needsRow ? enemyRow : liveSource.scope === 'row' ? combatRows(next)[0] : undefined,
    targetPlayerId,
  )
  flushPendingTriggers(next)
  const rollPending = next.startTurnProgress?.rollPending
  if (rollPending && (next.pendingTriggers.length === 0 || combatIsOver(next))) {
    next.startTurnProgress = undefined
    finishStartTurnDraw(next, rollPending.drewFrom, !combatIsOver(next))
  }
  if (next.pendingTriggers.length === 0 && next.startTurnProgress?.beforeDraw) {
    return continueBeforeDraw(next)
  }
  const settled = settle(next)
  if ((settled.pendingTriggers?.length ?? 0) === 0 && settled.phase === 'start' &&
    settled.startTurnProgress && !settled.startTurnProgress.forcedCard &&
    !settled.startTurnProgress.beforeDraw && !settled.startTurnProgress.rollPending &&
    !settled.startTurnProgress.discard) {
    return continueStartTurn(settled, settled.startTurnProgress.choices)
  }
  if ((settled.pendingTriggers?.length ?? 0) === 0 && settled.endTurnProgress) {
    const order = refreshEndTurnTargets(settled, settled.endTurnProgress.order)
    delete settled.endTurnProgress
    return continueEndPlayerTurn(settled, order)
  }
  return settled
}
