// Start of Turn: reset, draw, roll the shared die, then work through the
// abilities that answer the new turn in the order the table chose (p.12).
//
// The phase is resumable on purpose. A Scry, a Facing choice or a forced card
// stops the sequence mid-way and parks its progress on the state, because the
// answer has to come from a player — and in a multiplayer game, from a player
// whose hand nobody else may see.
import {
  clone,
  combatIsOver,
  enemyLabel,
  findPlayer,
  lightningTargetOptions,
  livingEnemies,
  orbDamageTargets,
} from './board.ts'
import {
  applyEffect,
  dieRelicEffectsForParty,
  discardByCardEffect,
  drawInto,
  flushPendingTriggers,
  resolveTriggerSource,
  settle,
  triggerNeedsPlayerChoice,
  triggerSourceById,
  triggerSources,
} from './effects.ts'
import { applyEnemyAction } from './enemy-turn.ts'
import { canActivatePotion, canActivateRelic } from './items.ts'
import { addStatus, damageEnemy } from './pieces.ts'
import { effectEvokePlan, effectIsActive, invalidPlayChoice, mandatoryChoicePending, reachesEnemy } from './queries.ts'
import type {
  CombatState,
  EvokeChoice,
  StartTurnAbility,
  StartTurnChoice,
  StartTurnDiscardPreview,
  StartTurnScryAbility,
  StartTurnScryPreview,
  StartTurnSource,
  TriggerSource,
  PlayContext,
} from './types.ts'
import { cardDef } from '../cards.ts'
import { gainBlock, gainVulnerable } from '../damage.ts'
import { drawSummon, enemyAbilities, enemyDef, startingHp } from '../enemies.ts'
import { nextInt } from '../rng.ts'
import type { TriggerEvent } from '../triggers.ts'
import { CAPS } from '../types.ts'
import type { Enemy, OrbType, Player } from '../types.ts'
import { clearSlimeTurn } from '../downfall/slime-boss.ts'
import { shiftGuardianMode } from '../downfall/guardian.ts'
import { chosenDieRelicAbilities, relicDef } from '../relics.ts'

/**
 * Begins a Player Turn: either the first of the combat, or the one that
 * follows a finished Enemy Turn.
 *
 * The guard is the point. This is reachable from the network through the room
 * layer, and while it was callable at any moment a client could re-run it to
 * refill Energy, deal itself a fresh hand, and skip the Enemy Turn entirely.
 * Only two states may begin a turn: a combat that has not started, and a round
 * whose Enemy Turn has just ended.
 */
export function preparePlayerTurn(state: CombatState): CombatState {
  if (mandatoryChoicePending(state)) return state
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state))
}

/** Begins a turn but pauses after opening hands, before the shared Roll. */
export function preparePlayerTurnThroughDraw(state: CombatState): CombatState {
  if (mandatoryChoicePending(state)) return state
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state), true)
}

export function resolveDueSummons(next: CombatState, timing: 'startOfTurn' | 'endOfTurn'): void {
  const due = next.pendingSummons.filter((summon) =>
    (summon.timing ?? 'startOfTurn') === timing && summon.turn <= next.turn)
  next.pendingSummons = next.pendingSummons.filter((summon) => !due.includes(summon))
  for (const summon of due) {
    const source = next.enemies.find((enemy) => enemy.uid === summon.sourceUid)
    const ascension = source?.ascension
    summon.defIds.forEach((name, index) => {
      const defId = summon.direct ? name : drawSummon(next.summonSupply, name)
      if (!defId) {
        next.log = [...next.log, `No ${enemyDef(name).name} remained in the Summons deck`]
        return
      }
      const def = enemyDef(defId, ascension)
      const hp = startingHp(def, next.players.length)
      const summonBuff = source && enemyAbilities(enemyDef(source.defId, source.ascension))
        .find((ability) => ability.kind === 'buffSummons' && defId.startsWith(ability.defIdPrefix))
      const summoned: Enemy = {
        uid: `${summon.sourceUid}-summon-${next.turn}-${summon.row}-${index}`,
        defId, row: summon.row, isBoss: summon.isBoss ?? false, ascension,
        hp, maxHp: hp, block: summonBuff?.kind === 'buffSummons' ? summonBuff.block : 0,
        strength: (summon.strengthDefId === undefined || summon.strengthDefId === name ? summon.strength ?? 0 : 0) +
          (summon.strengthPerPower
            ? Math.max(0, ...next.players.filter((player) => !player.dead).map((player) => player.powers.length))
            : 0) + (summonBuff?.kind === 'buffSummons' ? summonBuff.strength : 0),
        vulnerable: 0, weak: 0, poison: 0, goldReward: 0, cardReward: null,
        actionIndex: 0, phase: 0, abilityUsed: false, dead: false,
      }
      const sourceIndex = source && source.row === summon.row &&
        (source.isBoss || enemyDef(source.defId, source.ascension).elite)
        ? next.enemies.indexOf(source) : -1
      if (sourceIndex < 0) next.enemies.push(summoned)
      else next.enemies.splice(sourceIndex, 0, summoned)
      next.log = [...next.log, `${def.name} was summoned`]
    })
  }
}

export function finishStartTurnDraw(next: CombatState, drewFrom: number, roll: boolean): void {
  if (roll) next.die = nextInt(next.rng, 6) + 1
  if (roll) for (const player of next.players) {
    const snecko = next.enemies.find((enemy) => !enemy.dead && enemy.row === player.row &&
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'confusion'))
    const confusion = snecko && enemyAbilities(enemyDef(snecko.defId, snecko.ascension))
      .find((ability) => ability.kind === 'confusion')
    if (confusion?.kind === 'confusion') player.enemyNextCardCost = confusion.byRoll[next.die] ?? null
    if (player.relics.some((relic) => relic.defId === 'snecko_eye') && next.die >= 5) {
      player.nextCardCost = next.die === 5 ? 2 : 0
    }
  }
  next.log = [
    ...next.log.slice(0, drewFrom),
    `Turn ${next.turn} begins${roll ? ` (die ${next.die})` : ''}`,
    ...next.log.slice(drewFrom),
  ]
}

function continueStartTurnDraw(next: CombatState, drewFrom: number, pauseAfterDraw = false): CombatState {
  for (const player of next.players) {
    if (player.dead) continue
    for (const relic of player.relics) {
      if (['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'downfall_nilrys_codex', 'loaded_die', 'fuel_canister'].includes(relic.defId)) relic.spent = false
    }
    drawInto(next, player, 5)
  }

  flushPendingTriggers(next)
  if (combatIsOver(next)) {
    finishStartTurnDraw(next, drewFrom, false)
    return settle(next)
  }
  if (next.pendingTriggers.length > 0) {
    next.startTurnProgress = { choices: [], rollPending: { drewFrom, pauseAfterDraw } }
    return next
  }
  if (pauseAfterDraw) {
    next.startTurnProgress = { choices: [], pauseAfterDraw: { drewFrom } }
    return next
  }
  // One roll per round; every die effect this round reads this value. It comes
  // after every Draw-step reaction, so the die cannot inform those choices.
  finishStartTurnDraw(next, drewFrom, true)
  return next
}

/** Start of Turn: reset, draw 5, then roll the shared die (p.12). Mutates `next`. */
function beginPlayerTurn(next: CombatState, pauseAfterDraw = false): CombatState {
  const opening = next.turn === 0
  next.phase = 'start'
  next.turn += 1
  resolveDueSummons(next, 'startOfTurn')
  for (const enemy of next.enemies) {
    if (!enemy.pendingDefId) continue
    enemy.defId = enemy.pendingDefId
    enemy.pendingDefId = undefined
    enemy.actionIndex = 0
    next.log = [...next.log, `${enemyLabel(next.enemies, enemy)} enters Defensive Mode`]
  }
  for (const source of next.enemies.filter((enemy) => !enemy.dead)) {
    for (const ability of enemyAbilities(enemyDef(source.defId, source.ascension))) {
      if (ability.kind === 'startRoundSelfVulnerable') {
        const before = source.vulnerable
        source.vulnerable = gainVulnerable(source.vulnerable, ability.amount)
        if (source.vulnerable > before) next.log = [...next.log,
          `${enemyLabel(next.enemies, source)} gains ${source.vulnerable - before} Vulnerable`]
      }
      if (ability.kind === 'reviveOnePerRow') for (const row of new Set(next.players
        .filter((player) => !player.dead).map((player) => player.row))) {
        const target = next.enemies.find((enemy) => enemy.dead && enemy.row === row &&
          enemy.defId.startsWith(ability.defIdPrefix))
        if (!target) continue
        target.dead = false
        target.hp = startingHp(enemyDef(target.defId, target.ascension), next.players.length)
        target.block = target.vulnerable = target.weak = target.poison = 0
        target.strength = 0
        target.actionIndex = 0
        target.abilityUsed = false
        next.log = [...next.log, `${enemyLabel(next.enemies, target)} revives through Infinite Blades`]
      }
    }
  }
  next.discardedThisTurn = []
  next.stanceChangedThisTurn = []
  next.powerTriggersUsedThisTurn = []
  next.playedCardsThisTurn = []
  next.partyAttackDiscount = false
  next.startTurnStage = 'effects'
  next.startTurnProgress = undefined
  // Where this round's log starts, so the divider can be placed above anything
  // the Start of Turn itself writes.
  const drewFrom = next.log.length

  // The Start of Turn phases run in the order the rulebook prints them (p.12):
  // Reset, Draw, Roll, then start-of-turn abilities. The order matters even
  // though the roll is independent of the draw today, because it decides which
  // RNG values each step consumes — swapping them changes every seeded replay.
  //
  // Reset is its own pass over the whole party before ANY drawing starts. The
  // rulebook prints them as two numbered steps, and now that drawing can fire
  // a Power, an interleaved loop would let one player's on-draw Block be wiped
  // by a later player's reset.
  for (const player of next.players) {
    if (player.dead) continue
    const leftover = !opening && player.relics.some((relic) => relic.defId === 'ice_cream') ? player.energy : 0
    player.energy = Math.min(CAPS.energy, 3 + leftover)
    player.nextCardCost = null
    player.enemyNextCardCost = null
    const shieldCharger = player.powers.find((power) => power.defId === 'guardian_shield_charger')
    if (shieldCharger) player.block = Math.min(player.block, shieldCharger.upgraded ? 3 : 2)
    const keepBlock = Boolean(shieldCharger) || player.powers.some((power) => cardDef(power.defId).retainBlock) || player.calipersArmed
    if (!keepBlock) player.block = 0
    player.calipersArmed = false
    player.drawLocked = false
    player.hpLostThisRound = 0
    player.hpLossLimitThisRound = undefined
    player.freeCardsThisTurn = 0
    player.freeAttacksThisTurn = 0
    player.freeGemCardsThisTurn = 0
    player.freePowersThisTurn = 0
    player.cardPlayLocked = false
    player.doubledAttacksThisTurn = 0
    player.tripledAttacksThisTurn = 0
    player.doubledCardsThisTurn = 0
    player.doubledSkillsThisTurn = 0
    player.retainCardsThisTurn = 0
    player.cardsPlayedThisTurn = 0
    player.energySpentThisTurn = 0
    player.nextPowerOrSlimeDiscount = undefined
    player.powerPlayedThisTurn = false
    player.damageDealtZeroThisTurn = false
    player.soulburnUsedThisTurn = false
    player.nextSoulburnDamageBonus = 0
    player.exhaustNextCardAfterUid = undefined
    player.attacksPlayedThisTurn = 0
    for (const slime of player.slimes) clearSlimeTurn(slime)
    player.nextAttackRapidFire = 0
    for (const pile of ['hand', 'draw', 'discard', 'exhaust', 'powers', 'chamber'] as const) {
      player[pile] = player[pile].map(({
        freeThisTurn: _free,
        costReductionThisTurn: _reduction,
        ...card
      }) => card)
    }
  }
  const beforeDraw = next.players.flatMap((player) => player.dead ? [] :
    triggerSources(player, { kind: 'beforeDraw' }).map((source) => ({
      playerId: player.id, sourceId: source.id,
    })))
  if (beforeDraw.length > 0) {
    next.startTurnProgress = {
      choices: [], beforeDraw: { drewFrom, sources: beforeDraw, ordered: beforeDraw.length === 1, pauseAfterDraw },
    }
    return next
  }
  return continueStartTurnDraw(next, drewFrom, pauseAfterDraw)
}

export function startTurnScryPreview(state: CombatState): StartTurnScryPreview | undefined {
  const beforeDraw = state.startTurnProgress?.beforeDraw
  const pending = state.phase === 'start' && state.pendingTriggers.length === 0 && beforeDraw?.ordered
    ? beforeDraw.sources[0]
    : undefined
  const player = pending && findPlayer(state, pending.playerId)
  const source = player && pending ? triggerSourceById(player, pending.sourceId) : undefined
  const effect = source?.trigger.kind === 'beforeDraw'
    ? source.effects.find((candidate) => candidate.kind === 'scry')
    : undefined
  if (!player || !source || !effect || effect.kind !== 'scry') return undefined
  return {
    id: `${state.combatId}/${state.turn}/${player.id}/${source.id}`,
    playerId: player.id,
    label: source.name,
    amount: effect.amount,
    cards: player.draw.slice(0, effect.amount),
  }
}

export function startTurnScryAbilities(state: CombatState): StartTurnScryAbility[] {
  const progress = state.phase === 'start' ? state.startTurnProgress?.beforeDraw : undefined
  if (!progress || progress.ordered) return []
  return progress.sources.flatMap((pending) => {
    const player = findPlayer(state, pending.playerId)
    const source = player && triggerSourceById(player, pending.sourceId)
    const effect = source?.trigger.kind === 'beforeDraw'
      ? source.effects.find((candidate) => candidate.kind === 'scry')
      : undefined
    return player && source && effect?.kind === 'scry' ? [{
      id: `${state.combatId}/${state.turn}/${player.id}/${source.id}`,
      playerId: player.id,
      label: source.name,
      amount: effect.amount,
    }] : []
  })
}

export function orderStartTurnScries(state: CombatState, order: readonly string[]): CombatState {
  const progress = state.phase === 'start' ? state.startTurnProgress?.beforeDraw : undefined
  if (!progress || progress.ordered || state.pendingTriggers.length > 0) return state
  const byId = new Map(progress.sources.map((source) => [
    `${state.combatId}/${state.turn}/${source.playerId}/${source.sourceId}`, source,
  ]))
  if (order.length !== byId.size || new Set(order).size !== byId.size ||
    order.some((id) => !byId.has(id))) return state
  const next = clone(state)
  next.startTurnProgress!.beforeDraw!.sources = order.map((id) => ({ ...byId.get(id)! }))
  next.startTurnProgress!.beforeDraw!.ordered = true
  return next
}

export function continueBeforeDraw(state: CombatState): CombatState {
  const progress = state.startTurnProgress?.beforeDraw
  if (state.pendingCardCopy) return state
  if (!progress || progress.sources.length > 0 || state.pendingTriggers.length > 0) return settle(state)
  state.startTurnProgress = undefined
  const continued = continueStartTurnDraw(state, progress.drewFrom, progress.pauseAfterDraw)
  return progress.pauseAfterDraw ? continued : finishPreparedStartTurnWithChoices(continued)
}

/** Continues Mysterious Sphere from its printed after-Draw interruption. */
export function resumePlayerTurnAfterDraw(state: CombatState): CombatState {
  const pending = state.startTurnProgress?.pauseAfterDraw
  if (state.phase !== 'start' || !pending || state.pendingTriggers.length > 0) return state
  const next = clone(state)
  next.startTurnProgress = undefined
  finishStartTurnDraw(next, pending.drewFrom, true)
  return finishPreparedStartTurnWithChoices(next)
}

/** Resolves the current owner's private pre-draw Scry and advances the Draw step. */
export function resolveStartTurnScry(
  state: CombatState,
  playerId: string,
  sourceId: string,
  discardUids: readonly string[],
): CombatState {
  const preview = startTurnScryPreview(state)
  const pending = state.startTurnProgress?.beforeDraw?.sources[0]
  if (!preview || !pending || preview.playerId !== playerId || preview.id !== sourceId) return state
  const player = findPlayer(state, playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!player || !source) return state

  const next = clone(state)
  const progress = next.startTurnProgress!.beforeDraw!
  progress.sources = progress.sources.slice(1)
  const actor = findPlayer(next, playerId)!
  const liveSource = triggerSourceById(actor, pending.sourceId)!
  if (!resolveTriggerSource(
    next, actor, liveSource, false, undefined, undefined, undefined, undefined, undefined, discardUids,
  )) return state
  return continueBeforeDraw(next)
}

export function triggerTargets(state: CombatState, player: Player, source: TriggerSource) {
  return (source.scope === 'enemy' || source.scope === 'row') &&
    source.effects.some((effect) => reachesEnemy(effect, player))
    ? livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
    : undefined
}

function startTurnSources(state: CombatState): StartTurnSource[] {
  if (state.phase !== 'start' || state.startTurnProgress?.beforeDraw || state.startTurnProgress?.rollPending ||
    state.startTurnProgress?.pauseAfterDraw || state.startTurnProgress?.discard) return []
  const events: TriggerEvent[] = [
    ...(state.turn === 1 ? [{ kind: 'startOfCombat' as const }] : []),
    { kind: 'startOfTurn' },
    { kind: 'dieRelic', die: state.die },
  ]
  const playerSources = events.flatMap((event) => state.players.flatMap((player) => player.dead ? [] :
    triggerSources(player, event).map((source) => ({
      source,
      ability: {
        id: `${player.id}/${source.id}`,
        playerId: player.id,
        label: source.name,
        targets: triggerTargets(state, player, source),
        players: triggerNeedsPlayerChoice(state, source)
          ? state.players.filter((candidate) => !candidate.dead)
            .map((candidate) => ({ id: candidate.id, label: candidate.name }))
          : undefined,
      },
    }))))
  const owner = state.players.find((player) => !player.dead)
  if (state.startTurnStage === 'facing') {
    const facing = livingEnemies(state).filter((enemy) =>
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
    return owner ? state.players.filter((player) => !player.dead).map((player) => ({
      facingPlayerId: player.id,
      ability: {
        id: `facing:${player.id}`,
        playerId: player.id,
        label: `${player.name} — choose Facing`,
        targets: [...facing.map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) })),
          ...(facing.length === 1 ? [{ uid: 'none', label: 'No Facing enemy' }] : [])],
      },
    })) : []
  }
  const enemySources: StartTurnSource[] = []
  const guardianSources: StartTurnSource[] = state.players.filter((player) =>
    !player.dead && player.character === 'guardian' && player.guardianMode !== null && !player.guardianModeLocked)
    .map((player) => ({
      guardianModeShiftPlayerId: player.id,
      ability: {
        id: `guardian:${player.id}/mode-shift`,
        playerId: player.id,
        label: `${player.name} — Mode Shift`,
        guardianModeShift: true,
      },
    }))
  if (owner) for (const enemy of livingEnemies(state)) {
    const def = enemyDef(enemy.defId, enemy.ascension)
    const amount = state.turn === 1 ? def.startingBlock ?? 0 : 0
    if (amount > 0) enemySources.push({
      enemyUid: enemy.uid, enemyBlock: amount,
      ability: { id: `enemy:${enemy.uid}/starting-block`, playerId: owner.id,
        label: `${enemyLabel(state.enemies, enemy)} — ${amount} Block` },
    })
  }
  const regrow = owner && state.enemies.some((enemy) => enemy.dead &&
    (enemy.defId.startsWith('darkling') || enemy.defId.startsWith('downfall_darkling_'))) &&
    livingEnemies(state).find((enemy) =>
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'regrow'))
  if (owner && regrow) enemySources.push({
    enemyUid: regrow.uid, enemyAction: { kind: 'reviveAll', group: 'darkling' },
    ability: { id: 'enemy:darkling/regrow', playerId: owner.id,
      label: `${enemyLabel(state.enemies, regrow)} — Regrow` },
  })
  return [...guardianSources, ...playerSources, ...enemySources]
}

function pendingStartTurnSources(state: CombatState): StartTurnSource[] {
  if (state.startTurnProgress?.forcedCard) return []
  const sources = startTurnSources(state)
  const queued = state.startTurnProgress?.choices
  if (!queued) return sources
  const ids = new Set(queued.map((choice) => choice.id))
  return sources.filter(({ ability }) => ids.has(ability.id))
}

/** Computes the collision-free physical row for every partial Facing choice. */
function facingRowPlan(
  state: CombatState,
  choices: readonly StartTurnChoice[],
): Map<string, number> | null {
  const byId = new Map(startTurnSources(state).map((entry) => [entry.ability.id, entry]))
  const enemies = livingEnemies(state).filter((enemy) =>
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
  const playerRows = new Map(state.players.map((player) => [player.id, player.row]))
  const occupied = new Set(choices.flatMap((choice) => {
    const playerId = byId.get(choice.id)?.facingPlayerId
    const row = playerId ? playerRows.get(playerId) : undefined
    return enemies.length > 1 && choice.enemyUid === 'none' && row !== undefined ? [row] : []
  }))
  const counts = new Map<string, number>()
  for (const choice of choices) {
    const entry = byId.get(choice.id)
    if (!entry?.facingPlayerId || choice.enemyUid === undefined) continue
    if (!entry.ability.targets?.some((target) => target.uid === choice.enemyUid)) return null
    const currentRow = playerRows.get(entry.facingPlayerId)
    if (currentRow === undefined) return null
    const enemy = choice.enemyUid === 'none'
      ? enemies.length === 1 ? enemies[0] : undefined
      : enemies.find((candidate) => candidate.uid === choice.enemyUid)
    if (!enemy) {
      if (choice.enemyUid === 'none' && enemies.length > 1) continue
      return null
    }
    const facing = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
      .find((ability) => ability.kind === 'facing')
    if (facing?.kind !== 'facing') return null
    if (choice.enemyUid !== 'none') {
      const assigned = counts.get(enemy.uid) ?? 0
      if (assigned >= 2) return null
      counts.set(enemy.uid, assigned + 1)
    }
    const facesEnemy = choice.enemyUid !== 'none'
    const rows = (facing.effect === 'spear') === facesEnemy ? [2, 3] : [0, 1]
    const row = rows.includes(currentRow) && !occupied.has(currentRow)
      ? currentRow
      : rows.find((candidate) => !occupied.has(candidate))
    if (row === undefined) return null
    playerRows.set(entry.facingPlayerId, row)
    occupied.add(row)
  }
  return playerRows
}

/** Validates the two physical row slots available on each Facing side. */
export function facingChoicesAreValid(state: CombatState, choices: readonly StartTurnChoice[]): boolean {
  return facingRowPlan(state, choices) !== null
}

function validStartTurnOrder(sources: readonly StartTurnSource[], order: readonly string[]): boolean {
  const expected = new Set(sources.map(({ ability }) => ability.id))
  return order.length === expected.size && new Set(order).size === expected.size &&
    order.every((id) => expected.has(id))
}

/** Ordered Start-of-Turn abilities, with overflow recomputed for that exact order. */
function startTurnAbilitiesFor(
  state: CombatState,
  sources: readonly StartTurnSource[],
  order?: readonly string[],
  choices: readonly StartTurnChoice[] = [],
): StartTurnAbility[] {
  const ids = order ?? sources.map(({ ability }) => ability.id)
  if (!validStartTurnOrder(sources, ids)) return []
  const byId = new Map(sources.map((entry) => [entry.ability.id, entry]))
  const choiceById = new Map(choices.map((choice) => [choice.id, choice]))
  let plannedState = clone(state)
  let plannedShivs = state.players.reduce((sum, player) => sum + player.shivs, 0)
  let planningBlocked = false
  let planningEnded = false
  return ids.map((id) => {
    const entry = byId.get(id)!
    if (planningEnded) return { ...entry.ability, targets: undefined, overflowShivs: 0 }
    const simulationState = clone(plannedState)
    const player = findPlayer(simulationState, entry.ability.playerId)!
    const planningPlayer = player
    const plannedEnemies = simulationState.enemies
    const targetOptions = () => plannedEnemies.filter((enemy) => !enemy.dead)
      .map((enemy) => ({ uid: enemy.uid, label: enemyLabel(plannedEnemies, enemy) }))
    const choice = choiceById.get(id)
    if (!entry.source) {
      if (entry.guardianModeShiftPlayerId && choice?.guardianModeShift) {
        planningPlayer.guardianMode = shiftGuardianMode(planningPlayer.guardianMode!)
        plannedState = simulationState
      }
      const enemy = entry.enemyUid && plannedEnemies.find((candidate) => candidate.uid === entry.enemyUid)
      if (!planningBlocked && enemy) {
        if (entry.enemyAction) applyEnemyAction(simulationState, enemy, entry.enemyAction)
        else enemy.block = gainBlock(enemy.block, entry.enemyBlock ?? 0)
        plannedState = simulationState
      }
      return { ...entry.ability, overflowShivs: 0 }
    }
    const playerTargetStale = Boolean(entry.ability.players &&
      !entry.ability.players.some((candidate) => candidate.id === choice?.targetPlayerId))
    if (playerTargetStale) planningBlocked = true
    const shivs = entry.source.effects.reduce((sum, effect) => sum + (
      effect.kind === 'gainShiv' && effectIsActive(effect, plannedState, player) ? effect.amount : 0
    ), 0)
    const gained = Math.min(Math.max(0, CAPS.shivs - plannedShivs), shivs)
    const overflowShivs = shivs - gained
    plannedShivs += gained
    const targets = entry.ability.targets ? targetOptions() : undefined
    const enemyTargetStale = Boolean(targets?.length && choice?.enemyUid !== undefined &&
      !targets.some((target) => target.uid === choice.enemyUid))
    if (entry.ability.targets && targets!.length > 0 &&
      (choice?.enemyUid === undefined || enemyTargetStale)) planningBlocked = true
    let staleShivIndex: number | undefined
    let shivTargets: StartTurnAbility['shivTargets']
    let shivEndedCombat = false
    if (!planningBlocked) {
      const chosenShivs = choice?.shivEnemyUids ?? []
      for (let index = 0; !planningBlocked && index < overflowShivs; index++) {
        if (index >= chosenShivs.length) {
          staleShivIndex = index
          shivTargets = targetOptions()
          planningBlocked = true
          break
        }
        const uid = chosenShivs[index]
        if (uid == null) continue
        const target = plannedEnemies.find((enemy) => !enemy.dead && enemy.uid === uid)
        if (!target) {
          if (targetOptions().length === 0) continue
          staleShivIndex = index
          shivTargets = targetOptions()
          planningBlocked = true
          break
        }
        applyEffect(
          simulationState,
          planningPlayer,
          { kind: 'hit', amount: 1 + planningPlayer.shivDamageBonus },
          'enemy', 'self', { enemyUid: uid, playerId: null }, 'Shiv',
        )
        if (targetOptions().length === 0) {
          shivEndedCombat = true
          break
        }
      }
    }
    let evokeChoice: EvokeChoice | undefined
    let evokeTargets: StartTurnAbility['evokeTargets']
    let evokeOrbs: OrbType[] = []
    let evokeTargetIndex: number | undefined
    let evokePlanComplete = false
    let evokeEndedCombat = false
    if (!planningBlocked) {
      const plan = effectEvokePlan(entry.source.effects, planningPlayer, choice?.evokeSlots ?? [])
      evokeOrbs = plan.chosen
      for (let index = 0; index < plan.chosen.length; index++) {
        const orb = plan.chosen[index]
        if (orb === 'frost') continue
        const damageTargets = orbDamageTargets(
          simulationState, planningPlayer, orb!, choice?.evokeEnemyUids?.[index],
        )
        if (!damageTargets) {
          evokeTargetIndex = index
          evokeTargets = orb === 'lightning'
            ? lightningTargetOptions(simulationState, planningPlayer)
            : targetOptions()
          planningBlocked = true
          break
        }
        for (const target of damageTargets) {
          damageEnemy(simulationState, target, (orb === 'lightning' ? 2 :
            3 + player.powers.length + (player.darkOrbEvokeBonus ?? 0)) +
            (player.orbEvokeBonus ?? 0))
        }
        if (targetOptions().length === 0) {
          evokeEndedCombat = true
          break
        }
      }
      if (!planningBlocked) {
        evokeChoice = evokeEndedCombat ? undefined : plan.next ?? undefined
        if (plan.invalid || (plan.next && !evokeEndedCombat)) {
          evokeTargets = targetOptions()
          planningBlocked = true
        } else {
          planningPlayer.orbs = plan.orbs
          evokePlanComplete = true
        }
      }
    }
    if (!planningBlocked && evokePlanComplete) {
      const privateDraw = entry.source.effects.some((effect) =>
        effect.kind === 'draw' || effect.kind === 'drawThenDiscard')
      const forcedDraw = entry.source.effects.some((effect) => effect.kind === 'drawAndPlayFree')
      if (forcedDraw) {
        planningBlocked = true
      } else if (!privateDraw) {
        const exact = clone(plannedState)
        const exactPlayer = findPlayer(exact, entry.ability.playerId)!
        if (resolveTriggerSource(
          exact, exactPlayer, entry.source, false, choice?.shivEnemyUids, choice?.enemyUid, undefined,
          choice?.evokeSlots, choice?.evokeEnemyUids, undefined, choice?.targetPlayerId, choice?.exhaustUids,
        )) {
          plannedState = exact
          if (combatIsOver(exact)) planningEnded = true
          if (planningEnded || exact.startTurnProgress?.forcedCard) planningBlocked = true
        } else {
          planningBlocked = true
        }
      }
    }
    return {
      ...entry.ability, targets, enemyTargetStale,
      players: entry.ability.players,
      exhaustCards: entry.source.effects.some((effect) => effect.kind === 'exhaustFromHand')
        ? planningPlayer.hand
        : undefined,
      overflowShivs: shivEndedCombat ? choice?.shivEnemyUids.length ?? 0 : overflowShivs,
      staleShivIndex, shivTargets,
      evokeChoice, evokeTargets, evokeOrbs, evokeTargetIndex,
    }
  })
}

/** Ordered Start-of-Turn abilities, with overflow recomputed for that exact order. */
export function startTurnAbilities(
  state: CombatState,
  order?: readonly string[],
  choices: readonly StartTurnChoice[] = [],
): StartTurnAbility[] {
  return startTurnAbilitiesFor(state, pendingStartTurnSources(state), order, choices)
}

export function defaultStartTurnChoices(state: CombatState): StartTurnChoice[] {
  let lastEnemyUid: string | undefined
  const choices = startTurnAbilities(state).map((ability) => ({
    id: ability.id,
    enemyUid: ability.targets?.[0]?.uid,
    targetPlayerId: ability.players?.[0]?.id,
    exhaustUids: ability.exhaustCards?.slice(0, 1).map((card) => card.uid),
    guardianModeShift: ability.guardianModeShift ? false : undefined,
    shivEnemyUids: Array(ability.overflowShivs).fill(null),
    evokeSlots: [] as number[],
    evokeEnemyUids: [] as (string | null)[],
  }))
  while (true) {
    const abilities = startTurnAbilities(state, undefined, choices)
    const staleEnemy = abilities.find((ability) => ability.enemyTargetStale && ability.targets?.[0])
    if (staleEnemy) {
      choices.find((choice) => choice.id === staleEnemy.id)!.enemyUid = staleEnemy.targets![0]!.uid
      continue
    }
    const staleShiv = abilities.find((ability) => ability.staleShivIndex !== undefined)
    if (staleShiv?.shivTargets?.[0]) {
      choices.find((choice) => choice.id === staleShiv.id)!
        .shivEnemyUids[staleShiv.staleShivIndex!] = staleShiv.shivTargets[0].uid
      continue
    }
    const pendingEvokeTarget = abilities.find((ability) =>
      ability.evokeTargetIndex !== undefined && ability.evokeTargets?.[0])
    if (pendingEvokeTarget?.evokeTargets?.[0]) {
      const choice = choices.find((candidate) => candidate.id === pendingEvokeTarget.id)!
      choice.evokeEnemyUids![pendingEvokeTarget.evokeTargetIndex!] = pendingEvokeTarget.evokeTargets[0].uid
      lastEnemyUid = pendingEvokeTarget.evokeTargets[0].uid
      continue
    }
    const missingFrost = abilities.find((ability) => ability.evokeOrbs?.some((orb, index) =>
      orb === 'frost' && index >= (choices.find((choice) => choice.id === ability.id)?.evokeEnemyUids?.length ?? 0)))
    if (missingFrost?.evokeOrbs) {
      const choice = choices.find((candidate) => candidate.id === missingFrost.id)!
      choice.evokeEnemyUids!.push(...missingFrost.evokeOrbs
        .slice(choice.evokeEnemyUids!.length).map(() => null))
      continue
    }
    const pending = abilities.find((ability) => ability.evokeChoice)
    if (!pending?.evokeChoice) return choices
    const choice = choices.find((candidate) => candidate.id === pending.id)!
    const picked = pending.evokeChoice.options[0]
    if (!picked) return choices
    const targetUid = pending.evokeTargets?.[0]?.uid ?? lastEnemyUid ?? livingEnemies(state)[0]?.uid
    choice.evokeSlots!.push(picked.slot)
    choice.evokeEnemyUids!.push(picked.orb === 'frost' ? null : targetUid ?? null)
    if (picked.orb !== 'frost' && targetUid) lastEnemyUid = targetUid
  }
}

/** Resolves the ordered ability phase prepared by `preparePlayerTurn`. */
export function resolveStartPlayerTurn(
  state: CombatState,
  choices: readonly StartTurnChoice[],
): CombatState {
  if (state.phase !== 'start' || state.startTurnProgress?.forcedCard ||
    state.startTurnProgress?.beforeDraw || state.startTurnProgress?.rollPending ||
    state.startTurnProgress?.pauseAfterDraw || state.startTurnProgress?.discard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const sources = pendingStartTurnSources(state)
  const order = choices.map((choice) => choice.id)
  if (!validStartTurnOrder(sources, order)) return state

  const next = clone(state)
  next.startTurnProgress = undefined
  return continueStartTurn(next, choices, state)
}

function validStartTurnShivChoice(
  state: CombatState,
  player: Player,
  overflowShivs: number,
  enemyUids: readonly (string | null)[],
): boolean {
  if (enemyUids.length > overflowShivs) return false
  const simulation = clone(state)
  const actor = findPlayer(simulation, player.id)!
  for (const enemyUid of enemyUids) {
    if (combatIsOver(simulation)) return false
    if (enemyUid === null) continue
    const target = livingEnemies(simulation).find((enemy) => enemy.uid === enemyUid)
    if (!target) return false
    applyEffect(
      simulation, actor, { kind: 'hit', amount: 1 + actor.shivDamageBonus },
      'enemy', 'self', { enemyUid, playerId: null }, 'Shiv',
    )
  }
  return enemyUids.length === overflowShivs || combatIsOver(simulation)
}

function validStartTurnEvokeChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource | undefined,
  choice: StartTurnChoice,
): boolean {
  const slots = choice.evokeSlots ?? []
  const targets = choice.evokeEnemyUids ?? []
  if (!source) return slots.length === 0 && targets.length === 0
  const plan = effectEvokePlan(source.effects, player, slots)
  if (plan.invalid || plan.index !== slots.length || targets.length > plan.chosen.length) {
    return false
  }
  const simulation = clone(state)
  const actor = findPlayer(simulation, player.id)!
  for (let index = 0; index < plan.chosen.length; index++) {
    if (combatIsOver(simulation)) return targets.length === index
    if (index >= targets.length) return false
    const orb = plan.chosen[index]!
    if (orb === 'frost') {
      if (targets[index] !== null) return false
      continue
    }
    const damageTargets = orbDamageTargets(simulation, actor, orb, targets[index])
    if (!damageTargets) return false
    for (const target of damageTargets) {
      damageEnemy(simulation, target, (orb === 'lightning' ? 2 :
        3 + actor.powers.length + (actor.darkOrbEvokeBonus ?? 0)) +
        (actor.orbEvokeBonus ?? 0))
    }
  }
  return targets.length === plan.chosen.length && (!plan.next || livingEnemies(simulation).length === 0)
}

export function continueStartTurn(
  state: CombatState,
  choices: readonly StartTurnChoice[],
  rollback?: CombatState,
): CombatState {
  const facingRows = state.startTurnStage === 'facing' ? facingRowPlan(state, choices) : null
  if (state.startTurnStage === 'facing' && !facingRows) return rollback ?? state
  const next = state
  if (facingRows) for (const player of next.players) player.row = facingRows.get(player.id) ?? player.row
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]!
    const entry = startTurnSources(next).find(({ ability }) => ability.id === choice.id)
    const player = entry && findPlayer(next, entry.ability.playerId)
    const ability = entry ? startTurnAbilitiesFor(next, [entry])[0] : undefined
    if (!entry || !player || !ability ||
      (ability.targets
        ? ability.targets.length > 0 && !ability.targets.some((target) => target.uid === choice.enemyUid)
        : choice.enemyUid !== undefined) ||
      (ability.players
        ? !ability.players.some((candidate) => candidate.id === choice.targetPlayerId)
        : choice.targetPlayerId !== undefined) ||
      (ability.guardianModeShift
        ? typeof choice.guardianModeShift !== 'boolean'
        : choice.guardianModeShift !== undefined) ||
      !validStartTurnShivChoice(next, player, ability.overflowShivs, choice.shivEnemyUids) ||
      !validStartTurnEvokeChoice(next, player, entry.source, choice)) {
      next.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return rollback ?? next
    }
    if (!entry.source) {
      if (entry.guardianModeShiftPlayerId) {
        if (choice.guardianModeShift && player.guardianMode !== null && !player.guardianModeLocked) {
          player.guardianMode = shiftGuardianMode(player.guardianMode)
          next.log = [...next.log,
            `${player.name} enters ${player.guardianMode === 'attack' ? 'Attack' : 'Defense'} Mode`]
        }
      } else if (entry.facingPlayerId) {
        const facingPlayer = findPlayer(next, entry.facingPlayerId)
        const enemy = next.enemies.find((candidate) => !candidate.dead && candidate.uid === choice.enemyUid)
        if (!facingPlayer) return rollback ?? next
        if (choice.enemyUid === 'none') {
          if (livingEnemies(next).filter((candidate) => enemyAbilities(enemyDef(candidate.defId, candidate.ascension))
            .some((entry) => entry.kind === 'facing')).length !== 1) return rollback ?? next
          facingPlayer.facingEnemyUid = null
        } else {
          const facing = enemy && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
            .find((entry) => entry.kind === 'facing')
          if (!enemy || facing?.kind !== 'facing') return rollback ?? next
          facingPlayer.facingEnemyUid = enemy.uid
          if (facing.effect === 'spear') addStatus(next, facingPlayer, 'burn', 2, enemy.uid)
          else if (enemy.actionIndex === 0) facingPlayer.energy = Math.max(0, facingPlayer.energy - 1)
          else if (enemy.actionIndex === 1) facingPlayer.drawLocked = true
          else facingPlayer.damageDealtZeroThisTurn = true
        }
      } else if (entry.enemyUid) {
        const enemy = next.enemies.find((candidate) => candidate.uid === entry.enemyUid)
        if (enemy) {
          if (entry.enemyAction) applyEnemyAction(next, enemy, entry.enemyAction)
          else enemy.block = gainBlock(enemy.block, entry.enemyBlock ?? 0)
        }
      }
      continue
    }
    const checkpoint = rollback ? null : clone(next)
    if (!resolveTriggerSource(
      next, player, entry.source, false, choice.shivEnemyUids, choice.enemyUid, undefined,
      choice.evokeSlots, choice.evokeEnemyUids, undefined, choice.targetPlayerId, choice.exhaustUids,
    )) {
      if (rollback) return rollback
      checkpoint!.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return checkpoint!
    }
    if ((next.pendingTriggers?.length ?? 0) > 0) {
      next.startTurnProgress = { choices: choices.slice(index + 1).map((pending) => ({ ...pending })) }
      return settle(next)
    }
    if (next.startTurnProgress?.forcedCard) {
      next.startTurnProgress.choices = choices.slice(index + 1).map((pending) => ({ ...pending }))
      return settle(next)
    }
    if (next.startTurnProgress?.discard) {
      next.startTurnProgress.choices = choices.slice(index + 1).map((pending) => ({ ...pending }))
      return settle(next)
    }
    if (combatIsOver(next)) return settle(next)
  }
  next.startTurnProgress = undefined
  const facing = livingEnemies(next).some((enemy) =>
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
  if (next.startTurnStage !== 'facing' && facing) {
    next.startTurnStage = 'facing'
    return settle(next)
  }
  next.startTurnStage = undefined
  next.phase = 'player'
  return settle(next)
}

export function finishForcedCardPlay(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
  if (state.pendingDistilled) {
    const owner = findPlayer(state, state.pendingDistilled.playerId)
    const remaining = state.pendingDistilled.cards.filter((card) => owner?.hand.some((held) => held.uid === card.uid))
    state.pendingDistilled = remaining.length ? { ...state.pendingDistilled, cards: remaining } : undefined
  }
  if (choices === null || combatIsOver(state)) return state
  if ((state.pendingTriggers?.length ?? 0) > 0) {
    state.startTurnProgress = { choices: choices.map((choice) => ({ ...choice })) }
    return state
  }
  if (state.pendingCardCopy) {
    state.pendingCardCopy.forcedChoices = choices.map((choice) => ({ ...choice }))
    return state
  }
  if (state.startTurnProgress?.forcedCard) {
    state.startTurnProgress.choices = choices.map((choice) => ({ ...choice }))
    return state
  }
  if ((state.pendingDieRelicChoices?.length ?? 0) > 0) {
    state.startTurnProgress = { choices: choices.map((choice) => ({ ...choice })) }
    return state
  }
  return continueStartTurn(state, choices)
}

function resumeAfterDieRelicChoice(state: CombatState): CombatState {
  if ((state.pendingDieRelicChoices?.length ?? 0) === 0) flushPendingTriggers(state)
  const settled = settle(state)
  return (settled.pendingDieRelicChoices?.length ?? 0) === 0 && settled.phase === 'start' &&
    (settled.pendingTriggers?.length ?? 0) === 0 &&
    settled.startTurnProgress && !settled.startTurnProgress.forcedCard &&
    !settled.startTurnProgress.beforeDraw && !settled.startTurnProgress.rollPending &&
    !settled.startTurnProgress.pauseAfterDraw &&
    !settled.startTurnProgress.discard
    ? continueStartTurn(settled, settled.startTurnProgress.choices)
    : settled
}

export function resolvePendingDieRelicChoice(
  state: CombatState,
  playerId: string,
  context: Pick<PlayContext, 'discardUids' | 'exhaustUids'>,
): CombatState {
  const pending = state.pendingDieRelicChoices?.[0]
  if (!pending || pending.playerId !== playerId) return state
  const next = clone(state)
  let first = true
  while (next.pendingDieRelicChoices?.length) {
    const queued = next.pendingDieRelicChoices[0]!
    const owner = findPlayer(next, queued.playerId)
    const ability = owner && chosenDieRelicAbilities(relicDef(queued.relicDefId))[queued.abilityIndex]
    if (!owner || !ability || ability.trigger.kind !== 'dieRelic') return state
    const privateEffect = ability.effects.find((effect) =>
      effect.kind === 'discard' || effect.kind === 'exhaustFromHand')
    if (!first && privateEffect) break
    const selected = privateEffect?.kind === 'discard' ? context.discardUids ?? [] : context.exhaustUids ?? []
    const required = privateEffect ? Math.min(privateEffect.amount, owner.hand.length) : 0
    if (privateEffect && (new Set(selected).size !== selected.length ||
      selected.some((uid) => !owner.hand.some((card) => card.uid === uid)) ||
      (ability.optional ? selected.length !== 0 && selected.length !== required : selected.length !== required))) return state
    next.pendingDieRelicChoices = next.pendingDieRelicChoices.slice(1)
    if (!(ability.optional && selected.length === 0)) {
      const nestedContext: PlayContext = {
        enemyUid: queued.enemyUid,
        playerId: queued.targetPlayerId,
        ...(privateEffect?.kind === 'discard' ? { discardUids: selected } : {}),
        ...(privateEffect?.kind === 'exhaustFromHand' ? { exhaustUids: selected } : {}),
        shortfall: false,
        invalidDiscardChoice: false,
        invalidExhaustChoice: false,
        pendingTriggers: [],
      }
      for (const effect of dieRelicEffectsForParty(queued.relicDefId, ability.effects, next.players.length)) {
        applyEffect(next, owner, effect, ability.target ?? 'enemy', ability.supportTarget ?? 'self', nestedContext,
          queued.sourceLabel)
        if (invalidPlayChoice(nestedContext)) return state
      }
      if (nestedContext.pendingTriggers?.length) {
        next.pendingTriggers = [...nestedContext.pendingTriggers, ...(next.pendingTriggers ?? [])]
      }
    }
    first = false
  }
  return resumeAfterDieRelicChoice(next)
}

/** Deterministic disconnect fallback: mandatory payments resolve; optional ones are declined. */
export function defaultPendingDieRelicChoice(state: CombatState, playerId: string): CombatState {
  const pending = state.pendingDieRelicChoices?.[0]
  const owner = pending && findPlayer(state, playerId)
  const ability = pending && owner && chosenDieRelicAbilities(relicDef(pending.relicDefId))[pending.abilityIndex]
  if (!pending || pending.playerId !== playerId || !owner || !ability) return state
  const effect = ability.effects.find((candidate) => candidate.kind === 'discard' || candidate.kind === 'exhaustFromHand')
  const chosen = ability.optional || !effect ? [] : owner.hand.slice(0, effect.amount).map((card) => card.uid)
  return resolvePendingDieRelicChoice(state, playerId, effect?.kind === 'discard'
    ? { discardUids: chosen } : { exhaustUids: chosen })
}

export function finishCardCopy(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
  const resumed = finishForcedCardPlay(state, choices)
  return resumed.phase === 'start' && resumed.startTurnProgress?.beforeDraw
    ? continueBeforeDraw(resumed)
    : resumed
}

export function startTurnDiscardPreview(state: CombatState): StartTurnDiscardPreview | undefined {
  const pending = state.phase === 'start' ? state.startTurnProgress?.discard : undefined
  const player = pending && findPlayer(state, pending.playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!pending || !player || !source) return undefined
  return { playerId: player.id, sourceId: pending.sourceId, label: source.name, cards: player.hand }
}

/** Resolves Tools of the Trade without exposing its owner's hand to the table. */
export function resolveStartTurnDiscard(
  state: CombatState,
  playerId: string,
  sourceId: string,
  discardUid: string,
): CombatState {
  const preview = startTurnDiscardPreview(state)
  if (!preview || preview.playerId !== playerId || preview.sourceId !== sourceId ||
    !preview.cards.some((card) => card.uid === discardUid)) return state
  const next = clone(state)
  const pending = next.startTurnProgress!.discard!
  const choices = [...next.startTurnProgress!.choices]
  const actor = findPlayer(next, playerId)!
  const card = actor.hand.find((held) => held.uid === discardUid)!
  next.startTurnProgress = undefined
  next.pendingTriggers = [...next.pendingTriggers, ...pending.pendingTriggers]
  discardByCardEffect(next, actor, [card])
  flushPendingTriggers(next)
  if (combatIsOver(next)) return settle(next)
  if ((next.pendingTriggers?.length ?? 0) > 0) {
    next.startTurnProgress = { choices }
    return settle(next)
  }
  return continueStartTurn(settle(next), choices)
}

/** Backwards-compatible deterministic start for simulations with no UI choice. */
export function startPlayerTurn(state: CombatState): CombatState {
  let prepared = preparePlayerTurn(state)
  const scries = startTurnScryAbilities(prepared)
  if (scries.length > 0) prepared = orderStartTurnScries(prepared, scries.map((ability) => ability.id))
  for (let preview = startTurnScryPreview(prepared); preview; preview = startTurnScryPreview(prepared)) {
    const next = resolveStartTurnScry(prepared, preview.playerId, preview.id, [])
    if (next === prepared) break
    prepared = next
  }
  let resolved = prepared === state || prepared.phase !== 'start'
    ? prepared
    : resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
  for (let preview = startTurnDiscardPreview(resolved); preview; preview = startTurnDiscardPreview(resolved)) {
    const card = preview.cards[0]
    if (!card) break
    const next = resolveStartTurnDiscard(resolved, preview.playerId, preview.sourceId, card.uid)
    if (next === resolved) break
    resolved = next
  }
  return resolved
}

/** Starts a table-facing turn, pausing only when order or overflow matters. */
export function startPlayerTurnWithChoices(state: CombatState): CombatState {
  const prepared = preparePlayerTurn(state)
  if (prepared === state || prepared.phase !== 'start') return prepared
  if (prepared.startTurnProgress?.beforeDraw) return prepared
  return finishPreparedStartTurnWithChoices(prepared)
}

export function hasPostRollStartTurnChoice(state: CombatState): boolean {
  return state.players.some((player) => player.potions.some((potionId) =>
    canActivatePotion(state, player, potionId)) || player.relics.some((_relic, relicIndex) =>
    canActivateRelic(state, player, relicIndex)))
}

/**
 * Whether start-of-turn resolution contains an order, target, overflow, or Orb
 * decision — and so whether the table has to be stopped to make it.
 *
 * Two abilities used to be enough on their own, which put a "Resolve start of
 * turn" click in front of a turn where nothing about the sequence could change
 * the outcome. An ORDER only matters between two abilities that are AIMED at an
 * enemy: the target is revalidated on the other side of the turn —
 * "the cause is always an ability aimed at something an earlier ability kills".
 * A pair that only gains Block, draws, or channels an Orb commutes, so the
 * engine resolves them in its own canonical order and gets on with the game.
 */
export function startTurnNeedsChoice(
  state: CombatState,
  knownAbilities?: readonly StartTurnAbility[],
): boolean {
  if (hasPostRollStartTurnChoice(state)) return true
  const abilities = knownAbilities ?? startTurnAbilities(state)
  // An ability that cannot be resolved without input, whatever else is queued.
  if (abilities.some((ability) => (ability.exhaustCards?.length ?? 0) > 0 || ability.overflowShivs > 0 ||
    ability.guardianModeShift ||
    (ability.targets?.length ?? 0) > 1 ||
    (ability.players?.length ?? 0) > 1 || ability.evokeChoice)) return true
  if (abilities.some((ability) => ability.id === 'enemy:darkling/regrow') &&
    abilities.some((ability) => (ability.targets?.length ?? 0) > 0)) return true
  return abilities.filter((ability) => (ability.targets?.length ?? 0) > 0).length > 1
}

function finishPreparedStartTurnWithChoices(prepared: CombatState): CombatState {
  if (prepared.phase !== 'start' || prepared.startTurnProgress || prepared.pendingTriggers.length > 0) return prepared
  return startTurnNeedsChoice(prepared)
    ? prepared
    : resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
}
