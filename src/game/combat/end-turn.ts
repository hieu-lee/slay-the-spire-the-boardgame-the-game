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
  lightningRowFromTarget,
  lightningTargetOptions,
  lightningTargetsRows,
  livingEnemies,
  loopOrbTargets,
  parseLoopOrbTarget,
  resolveEnemyTargets,
  rowExists,
} from './board.ts'
import {
  applyEffect,
  damagePlayer,
  exhaustCards,
  flushPendingTriggers,
  losePlayerHp,
  pendingTriggerSlimeEnemyChoiceCount,
  resolveOrbAtEndOfTurn,
  resolveQueuedTriggerSource,
  resolveSlimeCommand,
  resolveTriggerSource,
  settle,
  triggerEnemyDeath,
  triggerNeedsEnemyChoice,
  triggerNeedsHermitChoice,
  triggerNeedsPlayerChoice,
  triggerNeedsRowChoice,
  triggerSlimeChoice,
  triggerHermitChoices,
  triggerSourceById,
  triggerSources,
} from './effects.ts'
import { forgetRetain, grantShiftBlock, loseEnemyHp, playerCanGainBlock, playerCanGainDebuffs, recordPoisonDamage } from './pieces.ts'
import {
  continueBeforeDraw,
  continueStartTurn,
  finishStartTurnDraw,
  resolveDueSummons,
  triggerTargets,
} from './start-turn.ts'
import { chooseEndTurnTarget, defaultEndTurnOrder, endTurnChoiceId, endTurnChoiceTarget } from './types.ts'
import { cardHasRetain, mandatoryChoicePending } from './queries.ts'
import type { CombatState, DiscardOrders, EndTurnAbility, EndTurnOrder, PendingTriggerAbility, TriggerSource } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import { gainBlock, gainWeak } from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import { discardHand } from '../piles.ts'
import type { CardInstance, Player } from '../types.ts'
import { removeTemporarySlimeVigor, slimeDef } from '../downfall/slime-boss.ts'

function playerEndTurnAbilities(state: CombatState, player: Player): Omit<EndTurnAbility, 'playerId'>[] {
  const abilities: Omit<EndTurnAbility, 'playerId'>[] = triggerSources(player, { kind: 'endOfTurn' })
    .map((source) => {
      const loop = source.effects.some((effect) => effect.kind === 'triggerOrbEndTurn')
      const stasis = source.powerUid && player.powers.some((power) =>
        power.uid === source.powerUid && power.defId === 'guardian_stasis_engine')
      const targets = stasis
        ? [...player.hand.map((card) => ({ uid: card.uid, label: cardDef(card.defId).name })),
          { uid: 'skip', label: 'Retain no card' }]
        : source.effects.some((effect) => effect.kind === 'optionalPreventRoundHpLoss')
          ? [{ uid: 'use', label: 'Exhaust to prevent HP loss' }, { uid: 'skip', label: 'Keep Invincible' }]
          : loop ? loopOrbTargets(player) : triggerTargets(state, player, source)
      return {
        id: source.id,
        label: source.name.replace(`${player.name}'s `, ''),
        targets,
        visual: source.id.startsWith('power:')
          ? { kind: 'card' as const, cardUid: source.id.slice(6) }
          : undefined,
        ...(loop && targets?.length ? { orbChoice: true } : {}),
      }
    })
  if ((player.strengthLossAtEndOfTurn ?? 0) > 0) {
    abilities.push({ id: 'strength', label: 'Lose temporary Strength' })
  }
  for (const slime of player.slimes) {
    const def = slimeDef(slime)
    if (def.slimeEndOfTurn) {
      const scope = commandSlimePreviewScope(slime)
      abilities.push({ id: `slime:${slime.card.uid}`, label: `${def.name} — Command`,
        targets: scope === 'enemy' || scope === 'allEnemies'
          ? livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
          : undefined,
        visual: { kind: 'slime', cardId: def.id } })
    }
    if (slime.vigorLossAtEndOfTurn > 0) abilities.push({ id: `slime-vigor:${slime.card.uid}`, label: `${def.name} — Lose temporary Vigor` })
  }
  player.orbs.forEach((orb, slot) => {
    if (orb === 'lightning') {
      const targets = lightningTargetOptions(state, player)
      if (targets.length === 0) return
      abilities.push({
        id: `orb:${slot}`,
        label: `Lightning Orb ${slot + 1}`,
        targets,
        visual: { kind: 'orb', orb, slot },
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
  for (const enemy of livingEnemies(state)) {
    const slimed = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
      .find((ability) => ability.kind === 'slimedHandHpLoss')
    if (slimed?.kind === 'slimedHandHpLoss') abilities.push({
      id: `downfall-slimed:${enemy.uid}`,
      label: `${enemyLabel(state.enemies, enemy)} — Slimed HP loss`,
    })
  }
  return abilities
}

function commandSlimePreviewScope(slime: Player['slimes'][number]) {
  const def = slimeDef(slime)
  return def.id === 'slime_boss_evolution_slime' && slime.level >= 3 ? 'allEnemies' : (def.slimeTarget ?? 'enemy')
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
  const playerAbilities = state.players.flatMap((player) => player.dead ? [] : playerEndTurnAbilities(state, player).map((ability) => ({
    ...ability,
    id: `${player.id}/${ability.id}`,
    playerId: player.id,
    label: `${player.name} — ${ability.label}`,
  })))
  const berserk = state.enemies.flatMap((enemy) => enemy.dead ? [] :
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'berserkHpLossPerPlayer')
      ? [{ id: `berserk:${enemy.uid}`, playerId: null, label: `${enemyLabel(state.enemies, enemy)} — Berserk` }]
      : [])
  return [
    ...playerAbilities.filter((ability) => ability.orbChoice),
    ...poison,
    ...beat,
    ...berserk,
    ...playerAbilities.filter((ability) => !ability.orbChoice),
  ]
}

export function validEndTurnOrder(abilities: readonly EndTurnAbility[], order: readonly string[]): boolean {
  const expected = new Set(abilities.map((ability) => ability.id))
  const ids = order.map(endTurnChoiceId)
  return order.length === expected.size && new Set(ids).size === expected.size && order.every((choice) => {
    const ability = abilities.find((candidate) => candidate.id === endTurnChoiceId(choice))
    const target = endTurnChoiceTarget(choice)
    return ability !== undefined && (ability.targets?.length
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
    const stasis = source?.powerUid && player?.powers.some((power) =>
      power.uid === source.powerUid && power.defId === 'guardian_stasis_engine')
    if (stasis) return chooseEndTurnTarget(id, 'skip')
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
  const fireBreathing = held.defId === 'burn'
    ? livingEnemies(state).flatMap((enemy) => enemyAbilities(enemyDef(enemy.defId, enemy.ascension)))
      .find((ability) => ability.kind === 'fireBreathing')
    : undefined
  for (const effect of def.handEndOfTurn ?? []) {
    if ('handSizeAtMost' in effect && effect.handSizeAtMost !== undefined &&
      player.hand.length > effect.handSizeAtMost) continue
    if (effect.kind === 'damage') {
      const block = player.block
      const amount = fireBreathing?.kind === 'fireBreathing' ? fireBreathing.burnDamage : effect.amount
      const outcome = damagePlayer(state, player, amount)
      const lost = outcome.hpLost
      const blocked = block - player.block
      state.log = [...state.log, lost > 0
        ? `${def.name} damages ${player.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : outcome.fullyBlocked
          ? `${player.name} blocks ${def.name} (${blocked} spent)`
          : `${def.name} did no damage to ${player.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`]
    } else if (effect.kind === 'loseHp') {
      const lost = losePlayerHp(state, player, effect.amount, true)
      if (lost > 0) state.log = [...state.log, `${def.name}: ${player.name} loses ${lost} HP`]
    } else if (effect.kind === 'gainWeak') {
      if (!playerCanGainDebuffs(player)) continue
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
      if (!fireBreathing) return
      break
    }
  }
  if (!def.ethereal && !fireBreathing) return

  player.hand = player.hand.filter((card) => card.uid !== uid)
  const before = new Set(player.hand.map((card) => card.uid))
  exhaustCards(state, player, [held])
  // FAQ: Dark Embrace draws caused by an end-turn Ethereal Exhaust ignore
  // end-turn/Ethereal text and are not discarded during this step.
  for (const card of player.hand) if (!before.has(card.uid)) card.endTurnProtected = true
  state.log = [...state.log, `${player.name} exhausts ${def.name}${def.ethereal ? ' (Ethereal)' : ''}`]
}

function continueEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder,
  interactive = false,
  resolveFirst = false,
): CombatState {
  const next = state
  for (let index = 0; index < order.length; index++) {
    // Earlier ordered effects may kill this ability's chosen enemy. Recompute
    // against the current board, not the board on which the order was submitted.
    const choice = refreshEndTurnTargets(next, [order[index]!])[0]!
    const id = endTurnChoiceId(choice)
    const ability = endTurnAbilities(next).find((candidate) => candidate.id === id)
    const needsEnemyDrag = ability?.orbChoice || ability?.targets?.some((target) => {
      const loop = parseLoopOrbTarget(target.uid)
      return !loop || loop.enemyUid !== null
    })
    if (interactive && !resolveFirst && needsEnemyDrag) {
      next.endTurnProgress = {
        order: order.slice(index),
        interactive: true,
        ...(next.endTurnProgress?.loopSelections ? { loopSelections: next.endTurnProgress.loopSelections } : {}),
        ...(next.endTurnProgress?.loopRepeats ? { loopRepeats: next.endTurnProgress.loopRepeats } : {}),
      }
      return settle(next)
    }
    resolveFirst = false
    if (id.startsWith('poison:')) {
      const enemy = next.enemies.find((candidate) => candidate.uid === id.slice(7))
      if (enemy && !enemy.dead && enemy.poison > 0) {
        const outcome = loseEnemyHp(next, enemy, enemy.poison)
        recordPoisonDamage(next, enemy, outcome.hpLost)
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
    } else if (id.startsWith('berserk:')) {
      const enemy = next.enemies.find((candidate) => candidate.uid === id.slice(8) && !candidate.dead)
      const berserk = enemy && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'berserkHpLossPerPlayer')
      if (enemy && berserk?.kind === 'berserkHpLossPerPlayer') {
        const outcome = loseEnemyHp(next, enemy, berserk.amount * next.players.length)
        enemy.hp = outcome.hp
        next.log = [...next.log, `${enemyLabel(next.enemies, enemy)} loses ${outcome.hpLost} HP to Berserk`]
        if (enemy.hp === 0) {
          enemy.dead = true
          triggerEnemyDeath(next, enemy)
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
        const stasis = source?.powerUid && player.powers.some((power) =>
          power.uid === source.powerUid && power.defId === 'guardian_stasis_engine')
        if (stasis) {
          const card = target === 'skip' ? undefined : player.hand.find((held) => held.uid === target)
          if (card) {
            card.retainThisTurn = true
            card.stasisRetained = true
            next.log = [...next.log,
              `${player.name}'s Stasis Engine Retains ${cardDef(card.defId).name}`]
          }
          continue
        }
        const optionalInvincible = source?.effects.some((effect) => effect.kind === 'optionalPreventRoundHpLoss')
        if (optionalInvincible && target === 'skip') continue
        const loop = source?.effects.some((effect) => effect.kind === 'triggerOrbEndTurn')
        const loopChoice = loop ? parseLoopOrbTarget(target) : undefined
        // A row is chosen when the order is submitted. Preserve that row if
        // an earlier ability kills its enemy anchor, without teaching ordinary
        // card plays that a dead enemy is a valid target.
        const selected = source?.scope === 'row'
          ? next.enemies.find((enemy) => enemy.uid === target)
          : undefined
        const livingMinionRows = selected?.isBoss
          ? [...new Set(livingEnemies(next).filter((enemy) => !enemy.isBoss).map((enemy) => enemy.row))]
          : []
        const selectedRow = selected?.isBoss && livingMinionRows.length === 1
          ? livingMinionRows[0]
          : selected?.row
        if (source && triggerNeedsHermitChoice(next, player, source)) {
          next.pendingTriggers ??= []
          next.nextTriggerId ??= 0
          next.pendingTriggers.push({
            id: next.nextTriggerId++, playerId: player.id, sourceId: source.id,
          })
        } else if (source && (optionalInvincible
          ? !resolveTriggerSource(next, player, source)
          : loop
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
      } else if (localId.startsWith('slime-vigor:')) {
        const slime = player.slimes.find((candidate) =>
          candidate.card.uid === localId.slice('slime-vigor:'.length))
        if (slime) removeTemporarySlimeVigor(slime)
      } else if (localId.startsWith('slime:')) {
        const slime = player.slimes.find((candidate) => candidate.card.uid === localId.slice(6))
        if (slime) resolveSlimeCommand(next, player, slime, {
          enemyUid: endTurnChoiceTarget(choice) ?? null, playerId: null,
        })
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
      } else if (localId.startsWith('downfall-slimed:')) {
        const enemy = next.enemies.find((candidate) => candidate.uid === localId.slice('downfall-slimed:'.length) && !candidate.dead)
        const slimed = enemy && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
          .find((ability) => ability.kind === 'slimedHandHpLoss')
        if (enemy && slimed?.kind === 'slimedHandHpLoss') {
          const count = player.hand.filter((card) => card.defId === 'slimed').length
          const lost = losePlayerHp(next, player, count * slimed.amount)
          if (lost > 0) next.log = [...next.log,
            `${enemyLabel(next.enemies, enemy)} makes ${player.name} lose ${lost} HP for Slimed in hand`]
          if (player.dead) next.log = [...next.log, `${player.name} has fallen`]
        }
      }
    }
    if (combatIsOver(next)) break
    if ((next.pendingTriggers?.length ?? 0) > 0) {
      next.endTurnProgress = {
        order: order.slice(index + 1),
        ...(interactive ? { interactive: true } : {}),
        ...(next.endTurnProgress?.loopSelections ? { loopSelections: next.endTurnProgress.loopSelections } : {}),
        ...(next.endTurnProgress?.loopRepeats ? { loopRepeats: next.endTurnProgress.loopRepeats } : {}),
      }
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
    !cardHasRetain(player, card))
  if (discarding.length <= 1) return false
  // Every pile, not just the hand: the card that cares may still be undrawn.
  return [player.hand, player.draw, player.discard, player.exhaust, player.powers, player.chamber]
    .some((pile) => pile.some(readsDiscardTop))
}

/** The next live target effect in the drag-to-resolve end-turn sequence. */
export function endTurnResolutionAbility(state: CombatState): EndTurnAbility | undefined {
  const progress = state.endTurnProgress
  if (state.phase !== 'player' || !progress?.interactive || progress.order.length === 0 ||
    (state.pendingTriggers?.length ?? 0) > 0) return undefined
  const choice = refreshEndTurnTargets(state, [progress.order[0]!])[0]!
  const ability = endTurnAbilities(state).find((candidate) => candidate.id === endTurnChoiceId(choice))
  if (!ability?.targets?.length) return undefined
  if (progress.rowTiebreakFor !== ability.id) return ability
  const targets = ability.targets.filter((target) => {
    const loop = parseLoopOrbTarget(target.uid)
    const choice = loop?.enemyUid ?? target.uid
    const row = lightningRowFromTarget(choice)
    return row !== null
      ? livingEnemies(state).some((enemy) => !enemy.isBoss && enemy.row === row)
      : state.enemies.some((enemy) => enemy.uid === choice && !enemy.dead && !enemy.isBoss)
  })
  return targets.length > 0 ? { ...ability, targets, rowTiebreak: true } : undefined
}

function needsBossRowTiebreak(state: CombatState, ability: EndTurnAbility, targetUid: string): boolean {
  const loop = parseLoopOrbTarget(targetUid)
  const chosenUid = loop?.enemyUid ?? targetUid
  if (state.enemies.find((enemy) => enemy.uid === chosenUid)?.isBoss !== true) return false
  const slash = ability.id.indexOf('/')
  const player = findPlayer(state, ability.id.slice(0, slash))
  const source = player && triggerSources(player, { kind: 'endOfTurn' })
    .find((candidate) => candidate.id === ability.id.slice(slash + 1))
  const targetsRows = source?.scope === 'row' || player !== undefined && (
    ability.id.slice(slash + 1).startsWith('orb:') ||
    source?.effects.some((effect) => effect.kind === 'triggerOrbEndTurn') === true
  ) && lightningTargetsRows(player)
  return targetsRows && new Set(livingEnemies(state)
    .filter((enemy) => !enemy.isBoss)
    .map((enemy) => enemy.row)).size > 1
}

function prepareEndTurn(state: CombatState): CombatState {
  const next = clone(state)
  for (const player of next.players) {
    player.hand = player.hand.map(({ stasisRetained: _stasis, ...card }) => card)
    if (player.block === 0 && playerCanGainBlock(player) && player.relics.some((relic) => relic.defId === 'orichalcum')) {
      player.block = gainBlock(player.block, 1)
      next.log = [...next.log, `${player.name}'s Orichalcum grants 1 Block`]
    }
  }
  return next
}

/** Begins end-of-turn resolution and stops only when a live effect needs a target. */
export function beginEndTurnResolution(state: CombatState): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const next = prepareEndTurn(state)
  return continueEndPlayerTurn(next, defaultEndTurnOrder(endTurnAbilities(next)), true)
}

/** Resolves the displayed target effect, then advances until another live target is needed. */
export function resolveEndTurnAbility(state: CombatState, choice: string): CombatState {
  const ability = endTurnResolutionAbility(state)
  const target = endTurnChoiceTarget(choice)
  if (!ability || target === undefined || endTurnChoiceId(choice) !== ability.id ||
    choice !== chooseEndTurnTarget(ability.id, target) || !ability.targets?.some((candidate) => candidate.uid === target)) {
    return state
  }
  const next = clone(state)
  const slash = ability.id.indexOf('/')
  const player = findPlayer(next, ability.id.slice(0, slash))
  const source = player && triggerSources(player, { kind: 'endOfTurn' })
    .find((candidate) => candidate.id === ability.id.slice(slash + 1))
  const loop = source?.effects.find((effect) => effect.kind === 'triggerOrbEndTurn')
  const loopChoice = ability.orbChoice ? parseLoopOrbTarget(target) : undefined
  if (player && loop?.kind === 'triggerOrbEndTurn' && loopChoice) {
    const progress = next.endTurnProgress!
    const remaining = progress.loopSelections?.[ability.id] ?? loop.amount
    const repeats = [...(progress.loopRepeats ?? []), `${player.id}/orb:${loopChoice.slot}`]
    const rest = progress.order.slice(1)
    const selections = { ...progress.loopSelections }
    if (remaining > 1) selections[ability.id] = remaining - 1
    else delete selections[ability.id]
    const moreLoops = rest.some((pending) => endTurnAbilities(next)
      .find((candidate) => candidate.id === endTurnChoiceId(pending))?.orbChoice)
    const order = remaining > 1
      ? [ability.id, ...rest]
      : moreLoops ? rest : [...repeats, ...rest]
    next.endTurnProgress = {
      order,
      interactive: true,
      ...(Object.keys(selections).length > 0 ? { loopSelections: selections } : {}),
      ...((remaining > 1 || moreLoops) ? { loopRepeats: repeats } : {}),
    }
    return continueEndPlayerTurn(next, order, true)
  }
  if (needsBossRowTiebreak(next, ability, target)) {
    next.endTurnProgress = { ...next.endTurnProgress!, rowTiebreakFor: ability.id }
    return next
  }
  const order = next.endTurnProgress!.order
  return continueEndPlayerTurn(next, [choice, ...order.slice(1)], true, true)
}

/** Resolves end-of-turn effects in each player's chosen order, then asks for discards. */
export function beginEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder = defaultEndTurnOrder(endTurnAbilities(state)),
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard || mandatoryChoicePending(state) ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const abilities = endTurnAbilities(state)
  if (!validEndTurnOrder(abilities, order)) return state
  if (abilities.some((ability) => ability.orbChoice)) return beginEndTurnResolution(state)
  const next = prepareEndTurn(state)
  return continueEndPlayerTurn(next, order)
}

/** Whether an ordered discard omits only cards this player may Retain. */
export function discardOrderIsValid(player: Player, order: readonly string[]): boolean {
  const hand = new Set(player.hand.map((card) => card.uid))
  if (new Set(order).size !== order.length || order.some((uid) => !hand.has(uid))) return false
  const ordered = new Set(order)
  const optionallyRetained = player.hand.filter((card) =>
    !ordered.has(card.uid) && !card.endTurnProtected && !card.retainThisTurn &&
      !cardHasRetain(player, card))
  return optionallyRetained.length <= (player.retainCardsThisTurn ?? 0)
}

/** End of Turn: resolve effects, then discard every hand in chosen order. */
export function endPlayerTurn(state: CombatState, discardOrders: DiscardOrders = {}): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  if (state.endTurnProgress?.interactive) return state
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
        !cardHasRetain(player, card))
      .map((card) => card.uid))
    const keep = hand
      .filter((held) => chosenRetain.has(held.uid) || held.endTurnProtected || held.retainThisTurn ||
        cardHasRetain(player, held))
      .map((held) => held.uid)
    const piles = discardHand({ ...player, hand }, keep)
    player.draw = piles.draw
    player.hand = piles.hand.map((held) => {
      const clean = forgetRetain({ ...held, endTurnProtected: undefined })
      return chosenRetain.has(held.uid) || held.retainThisTurn ||
        cardHasRetain(player, held)
        ? { ...clean, retainedLastTurn: true,
          ...(held.stasisRetained ? { stasisRetained: true } : {}) }
        : clean
    })
    player.discard = piles.discard.map(forgetRetain)
    const discarded = held - keep.length
    if (discarded > 0) {
      next.log = [...next.log, `${player.name} discards ${discarded} at end of turn`]
    }
    player.retainCardsThisTurn = 0
    // Guardian's Spent zone empties after every Player Turn; cubes return to the supply.
    player.vigorSpentThisTurn = 0
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
  const choicePlayer = triggerChoicePlayer(state, player, source)
  const hermitChoices = triggerHermitChoices(choicePlayer, source)
  return {
    id: pending.id,
    playerId: player.id,
    label: source.name,
    rows: triggerNeedsRowChoice(state, player, source)
      ? combatRows(state).map((row) => ({ row, label: combatRowLabel(state, row) }))
      : undefined,
    targets: triggerNeedsEnemyChoice(state, choicePlayer, source, pending.enemyUid)
      ? livingEnemies(state).map((enemy) => ({
        uid: enemy.uid,
        label: enemyLabel(state.enemies, enemy),
      }))
      : undefined,
    players: triggerNeedsPlayerChoice(state, source)
      ? state.players.filter((candidate) => !candidate.dead).map((candidate) => ({ id: candidate.id, label: candidate.name }))
      : undefined,
    hermitChoices,
    slimeChoice: triggerSlimeChoice(state, player, source),
    slimeEnemyAmount: pendingTriggerSlimeEnemyChoiceCount(state, pending.id, []),
  }
}

function triggerChoicePlayer(state: CombatState, player: Player, source: TriggerSource): Player {
  if (source.presentationSourceId !== 'hermit_combo') return player
  const preview = clone(state)
  const choicePlayer = findPlayer(preview, player.id)!
  const draw = source.effects.find((effect) => effect.kind === 'draw')
  if (draw) applyEffect(preview, choicePlayer, draw, source.scope, source.supportScope, {
    enemyUid: null, playerId: choicePlayer.id, pendingTriggers: [],
  }, source.name)
  return choicePlayer
}

/** Resolve the oldest triggered ability before any other combat action. */
export function resolvePendingTrigger(
  state: CombatState,
  playerId: string,
  triggerId: number,
  enemyRow?: number,
  enemyUid?: string,
  targetPlayerId?: string,
  hermitChoices?: { loadUids?: string[]; chamberUids?: string[]; hermitEnemyUids?: string[]; slimeUids?: string[]; slimeEnemyUids?: string[] },
): CombatState {
  if ((state.pendingDieRelicChoices?.length ?? 0) > 0) return state
  const pending = state.pendingTriggers?.[0]
  if (!pending || pending.playerId !== playerId || pending.id !== triggerId) return state
  const player = findPlayer(state, playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!player || player.dead || !source) return state
  const choicePlayer = triggerChoicePlayer(state, player, source)
  const needsRow = triggerNeedsRowChoice(state, player, source)
  const needsEnemy = triggerNeedsEnemyChoice(state, choicePlayer, source, pending.enemyUid)
  const needsPlayer = triggerNeedsPlayerChoice(state, source)
  const needsHermit = triggerNeedsHermitChoice(state, choicePlayer, source)
  const needsSlime = triggerSlimeChoice(state, player, source)
  const slimeEnemyAmount = pendingTriggerSlimeEnemyChoiceCount(state, triggerId, hermitChoices?.slimeUids ?? [])
  if ((needsRow && !rowExists(state, enemyRow)) || (!needsRow && enemyRow !== undefined)) return state
  if ((needsEnemy && !livingEnemies(state).some((enemy) => enemy.uid === enemyUid)) ||
    (!needsEnemy && enemyUid !== undefined)) return state
  if ((needsPlayer && !state.players.some((candidate) => !candidate.dead && candidate.id === targetPlayerId)) ||
    (!needsPlayer && targetPlayerId !== undefined)) return state
  if (!needsHermit && (hermitChoices?.loadUids !== undefined || hermitChoices?.chamberUids !== undefined ||
    hermitChoices?.hermitEnemyUids !== undefined)) return state
  if (!needsSlime && hermitChoices?.slimeUids !== undefined) return state
  if ((hermitChoices?.slimeEnemyUids?.length ?? 0) !== slimeEnemyAmount ||
    hermitChoices?.slimeEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const queued = next.pendingTriggers.shift()!
  const liveSource = triggerSourceById(actor, queued.sourceId)!
  const resolved = resolveQueuedTriggerSource(
    next,
    actor,
    liveSource,
    queued.enemyUid ?? (needsEnemy ? enemyUid : liveSource.scope === 'enemy' || needsHermit
      ? livingEnemies(next)[0]?.uid
      : undefined),
    needsRow ? enemyRow : liveSource.scope === 'row' ? combatRows(next)[0] : undefined,
    targetPlayerId,
    hermitChoices,
  )
  if (!resolved) return state
  flushPendingTriggers(next)
  const rollPending = next.startTurnProgress?.rollPending
  if (rollPending && (next.pendingTriggers.length === 0 || combatIsOver(next))) {
    next.startTurnProgress = rollPending.pauseAfterDraw && !combatIsOver(next)
      ? { choices: [], pauseAfterDraw: { drewFrom: rollPending.drewFrom } }
      : undefined
    if (!rollPending.pauseAfterDraw || combatIsOver(next)) {
      finishStartTurnDraw(next, rollPending.drewFrom, !combatIsOver(next))
    }
  }
  if (next.pendingTriggers.length === 0 && next.startTurnProgress?.beforeDraw) {
    return continueBeforeDraw(next)
  }
  const settled = settle(next)
  if ((settled.pendingTriggers?.length ?? 0) === 0 && settled.phase === 'start' &&
    settled.startTurnProgress && !settled.startTurnProgress.forcedCard &&
    !settled.startTurnProgress.beforeDraw && !settled.startTurnProgress.rollPending &&
    !settled.startTurnProgress.pauseAfterDraw &&
    !settled.startTurnProgress.discard) {
    return continueStartTurn(settled, settled.startTurnProgress.choices)
  }
  if ((settled.pendingTriggers?.length ?? 0) === 0 && settled.endTurnProgress) {
    const { order: pendingOrder, interactive } = settled.endTurnProgress
    const order = refreshEndTurnTargets(settled, pendingOrder)
    delete settled.endTurnProgress
    return continueEndPlayerTurn(settled, order, interactive === true)
  }
  return settled
}
