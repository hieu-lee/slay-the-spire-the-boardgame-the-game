// Start-of-Turn read-only queries, previews, planning, and choice predicates.
//
// Everything here is a pure query (or bounded simulation over cloned states)
// that lives strictly below `start-turn.ts`.
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
  resolveShivAttack,
  resolveTriggerSource,
  triggerNeedsPlayerChoice,
  triggerSourceById,
  triggerSources,
} from './effects.ts'
import { applyEnemyAction } from './enemy-turn.ts'
import { canActivatePotion, canActivateRelic } from './item-windows.ts'
import { damageEnemy } from './pieces.ts'
import { effectEvokePlan, effectIsActive, reachesEnemy } from './queries.ts'
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
} from './types.ts'
import { cardDef } from '../cards.ts'
import type { Effect } from '../cards.ts'
import { gainBlock } from '../damage.ts'
import { enemyAbilities, enemyDef } from '../enemies.ts'
import type { TriggerEvent } from '../triggers.ts'
import { CAPS } from '../types.ts'
import type { OrbType, Player } from '../types.ts'
import { shiftGuardianMode } from '../downfall/guardian.ts'
import { downfallRelicBaseId } from '../downfall/items.ts'

export const START_TURN_RELIC_ACTIVATIONS = new Set([
  'charons_ashes', 'dollys_mirror', 'fuel_canister', 'gambling_chip',
  'loaded_die', 'nilrys_codex', 'the_abacus', 'toolbox',
])

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

export function startTurnDiscardPreview(state: CombatState): StartTurnDiscardPreview | undefined {
  const pending = state.phase === 'start' ? state.startTurnProgress?.discard : undefined
  const player = pending && findPlayer(state, pending.playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!pending || !player || !source) return undefined
  return {
    playerId: player.id,
    sourceId: pending.sourceId,
    label: source.name,
    remaining: pending.remaining ?? 1,
    cards: player.hand.filter((card) => !pending.selectedUids?.includes(card.uid)),
  }
}

const hasOwn = Object.prototype.hasOwnProperty
const JSON_ESCAPE_RE = /["\\\x00-\x1f]/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function quoteJsonString(value: string): string {
  return JSON_ESCAPE_RE.test(value) ? JSON.stringify(value) : `"${value}"`
}

function stableJsonString(value: unknown): string {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'number') return Number.isFinite(value) ? `${value}` : 'null'
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'string') return quoteJsonString(value as string)
  if (Array.isArray(value)) {
    const length = value.length
    if (length === 0) return '[]'
    let out = '['
    for (let index = 0; index < length; index++) {
      if (index > 0) out += ','
      const item = value[index]
      out += item === undefined ? 'null' : stableJsonString(item)
    }
    return `${out}]`
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
    const length = keys.length
    if (length === 0) return '{}'
    if (length > 1) {
      let sorted = true
      for (let index = 1; index < length; index++) {
        if (keys[index - 1]! > keys[index]!) { sorted = false; break }
      }
      if (!sorted) keys.sort()
    }
    let out = '{'
    let first = true
    for (let index = 0; index < length; index++) {
      const key = keys[index]!
      const entry = value[key]
      if (entry === undefined) continue
      if (!first) out += ','
      first = false
      out += `${quoteJsonString(key)}:${stableJsonString(entry)}`
    }
    return `${out}}`
  }
  return 'null'
}

export function gameplaySignature(state: CombatState): string {
  const value: unknown = state
  if (!isPlainRecord(value)) return 'null'
  const keys = Object.keys(value).sort()
  let out = '{'
  let first = true
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    if (key === 'log' || key === 'presentationEvents') continue
    const entry = key === 'powerTriggersUsedThisTurn'
      ? [...state.powerTriggersUsedThisTurn].sort()
      : value[key]
    if (entry === undefined) continue
    if (!first) out += ','
    first = false
    out += `${quoteJsonString(key)}:${stableJsonString(entry)}`
  }
  return `${out}}`
}

function rawGameplayKey(state: CombatState): string {
  return JSON.stringify({ ...state, log: undefined, presentationEvents: undefined })
}

function sameStringBag(left: readonly string[], right: readonly string[]): boolean {
  const length = left.length
  if (length !== right.length) return false
  if (length === 0) return true
  if (length === 1) return left[0] === right[0]
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  for (let index = 0; index < length; index++) {
    if (sortedLeft[index] !== sortedRight[index]) return false
  }
  return true
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'number') {
    return !Number.isFinite(left) && !Number.isFinite(right)
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      const lv = left[index]
      const rv = right[index]
      if (lv === rv) continue
      if ((lv === undefined || lv === null) && (rv === undefined || rv === null)) continue
      if (!jsonValuesEqual(lv, rv)) return false
    }
    return true
  }
  if (Array.isArray(right) || !isPlainRecord(left) || !isPlainRecord(right)) return false
  let leftCount = 0
  for (const key in left) {
    if (!hasOwn.call(left, key)) continue
    const lv = left[key]
    if (lv === undefined) continue
    leftCount++
    if (!hasOwn.call(right, key)) return false
    const rv = right[key]
    if (lv !== rv && !jsonValuesEqual(lv, rv)) return false
  }
  let rightCount = 0
  for (const key in right) {
    if (hasOwn.call(right, key) && right[key] !== undefined) rightCount++
  }
  return leftCount === rightCount
}

function gameplayStatesEqual(left: CombatState, right: CombatState): boolean {
  if (left === right) return true
  const leftValue: unknown = left
  const rightValue: unknown = right
  if (!isPlainRecord(leftValue) || !isPlainRecord(rightValue)) return false
  let leftCount = 0
  for (const key in leftValue) {
    if (!hasOwn.call(leftValue, key) || key === 'log' || key === 'presentationEvents') continue
    const lv = leftValue[key]
    if (lv === undefined) continue
    leftCount++
    if (!hasOwn.call(rightValue, key)) return false
    if (key === 'powerTriggersUsedThisTurn') {
      if (!sameStringBag(left.powerTriggersUsedThisTurn, right.powerTriggersUsedThisTurn)) return false
      continue
    }
    const rv = rightValue[key]
    if (lv !== rv && !jsonValuesEqual(lv, rv)) return false
  }
  let rightCount = 0
  for (const key in rightValue) {
    if (hasOwn.call(rightValue, key) && key !== 'log' && key !== 'presentationEvents' && rightValue[key] !== undefined) {
      rightCount++
    }
  }
  return leftCount === rightCount
}

export function triggerTargets(state: CombatState, player: Player, source: TriggerSource) {
  return (source.scope === 'enemy' || source.scope === 'row') &&
    source.effects.some((effect) => reachesEnemy(effect, player))
    ? livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
    : undefined
}

/** One physical anchor per distinct row outcome; bosses belong to every row. */
function triggerChoiceOutcome(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
  targetPlayerId?: string,
): CombatState | undefined {
  const next = clone(state)
  const actor = findPlayer(next, player.id)
  const liveSource = actor && triggerSourceById(actor, source.id)
  if (!actor || !liveSource ||
    !resolveTriggerSource(next, actor, liveSource, { enemyUid, targetPlayerId })) return undefined
  return next
}

const EQUIVALENT_TARGET_VERDICT_LIMIT = 128
const equivalentTargetVerdicts = new Map<string, boolean>()

/** Collapses several visible anchors when every one has the same real result. */
function equivalentTriggerTargets<T extends { uid?: string; id?: string }>(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  targets: readonly T[],
  playerTargets = false,
  getStateKey?: () => string,
): T[] {
  if (targets.length < 2) return [...targets]
  // Planning replays the same board for every ability, seat and snapshot, and
  // each probe clones the combat; reuse the verdict.
  const stateKey = getStateKey ? getStateKey() : rawGameplayKey(state)
  const key = `${stateKey}|${player.id}|${source.id}|${playerTargets ? 'p' : 'e'}|` +
    targets.map((target) => target.uid ?? target.id).join(',')
  let collapses = equivalentTargetVerdicts.get(key)
  if (collapses === undefined) {
    const outcomeFor = (target: T) => triggerChoiceOutcome(
      state, player, source, playerTargets ? undefined : target.uid,
      playerTargets ? target.id : undefined,
    )
    const first = outcomeFor(targets[0]!)
    collapses = first !== undefined
    for (let index = 1; collapses && index < targets.length; index++) {
      const other = outcomeFor(targets[index]!)
      collapses = other !== undefined && gameplayStatesEqual(first!, other)
    }
    if (equivalentTargetVerdicts.size >= EQUIVALENT_TARGET_VERDICT_LIMIT) equivalentTargetVerdicts.clear()
    equivalentTargetVerdicts.set(key, collapses)
  }
  return collapses ? [targets[0]!] : [...targets]
}

function startTurnTriggerTargets(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  getStateKey?: () => string,
) {
  const targets = triggerTargets(state, player, source)
  if (!targets) return targets
  if (source.scope !== 'row') return equivalentTriggerTargets(state, player, source, targets, false, getStateKey)
  const minions = livingEnemies(state).filter((enemy) => !enemy.isBoss)
  if (minions.length === 0) return equivalentTriggerTargets(state, player, source, targets.slice(0, 1), false, getStateKey)
  const rows = new Set<number>()
  const rowTargets = minions.flatMap((enemy) => rows.has(enemy.row) ? [] : (
    rows.add(enemy.row), [{ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }]
  ))
  return equivalentTriggerTargets(state, player, source, rowTargets, false, getStateKey)
}

function startTurnTriggerPlayers(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  getStateKey?: () => string,
) {
  return triggerNeedsPlayerChoice(state, source)
    ? equivalentTriggerTargets(state, player, source, state.players
      .filter((candidate) => !candidate.dead)
      .map((candidate) => ({ id: candidate.id, label: candidate.name })), true, getStateKey)
    : undefined
}

export function startTurnSources(
  state: CombatState,
  includeDeadPlayers = false,
  onlyId?: string,
): StartTurnSource[] {
  if (state.phase !== 'start' || state.startTurnProgress?.beforeDraw || state.startTurnProgress?.rollPending ||
    state.startTurnProgress?.pauseAfterDraw || state.startTurnProgress?.discard) return []
  let cachedStateKey: string | undefined
  const getStateKey = () => (cachedStateKey ??= rawGameplayKey(state))
  const owner = state.players.find((player) => !player.dead)
  if (state.startTurnStage === 'facing') {
    if (!owner) return []
    const facing = livingEnemies(state).filter((enemy) =>
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'facing'))
    return state.players.filter((player) => !player.dead && (onlyId === undefined || `facing:${player.id}` === onlyId)).map((player) => ({
      facingPlayerId: player.id,
      ability: {
        id: `facing:${player.id}`,
        playerId: player.id,
        label: `${player.name} — choose Facing`,
        targets: [...facing.map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) })),
          ...(facing.length === 1 ? [{ uid: 'none', label: 'No Facing enemy' }] : [])],
      },
    }))
  }
  const events: TriggerEvent[] = [
    ...(state.turn === 1 ? [{ kind: 'startOfCombat' as const }] : []),
    { kind: 'startOfTurn' },
    { kind: 'dieRelic', die: state.die },
  ]
  const playerSources = events.flatMap((event) => state.players.flatMap((player) =>
    player.dead && !includeDeadPlayers ? [] :
    // Earlier effects can change a condition (Mayhem can enter Calm for Study).
    // Keep the source in the order and evaluate its effects when it resolves.
    triggerSources(player, event).filter((source) => {
      const abilityId = `${player.id}/${source.id}`
      return (onlyId === undefined || abilityId === onlyId) &&
        !state.powerTriggersUsedThisTurn.includes(abilityId)
    })
      .map((source) => ({
        source,
        ability: {
          id: `${player.id}/${source.id}`,
          playerId: player.id,
          label: source.name,
          visual: source.id.startsWith('relic:')
            ? { kind: 'relic' as const, relicId: source.presentationSourceId }
            : source.powerUid ? { kind: 'card' as const, cardUid: source.powerUid } : undefined,
          targets: startTurnTriggerTargets(state, player, source, getStateKey),
          players: startTurnTriggerPlayers(state, player, source, getStateKey),
        },
      }))))
  const enemySources: StartTurnSource[] = []
  const guardianSources: StartTurnSource[] = state.players.filter((player) =>
    (includeDeadPlayers || !player.dead) && player.character === 'guardian' &&
    player.guardianMode !== null && !player.guardianModeLocked &&
    (onlyId === undefined || `guardian:${player.id}/mode-shift` === onlyId))
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
    const id = `enemy:${enemy.uid}/starting-block`
    if (onlyId !== undefined && id !== onlyId) continue
    const def = enemyDef(enemy.defId, enemy.ascension)
    const amount = state.turn === 1 ? def.startingBlock ?? 0 : 0
    if (amount > 0) enemySources.push({
      enemyUid: enemy.uid, enemyBlock: amount,
      ability: { id, playerId: owner.id,
        label: `${enemyLabel(state.enemies, enemy)} — ${amount} Block` },
    })
  }
  const regrow = owner && (onlyId === undefined || onlyId === 'enemy:darkling/regrow') &&
    state.enemies.some((enemy) => enemy.dead &&
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

export function pendingStartTurnSources(state: CombatState): StartTurnSource[] {
  if (state.startTurnProgress?.forcedCard) return []
  const sources = startTurnSources(state)
  const queued = state.startTurnProgress?.choices
  if (!queued) return sources
  const ids = new Set(queued.map((choice) => choice.id))
  return sources.filter(({ ability }) => ids.has(ability.id))
}

/** Computes the collision-free physical row for every partial Facing choice. */
export function facingRowPlan(
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

/** Slayer Pack: Whether an ordered `<player>/power:<uid>` ability names a Power no longer in play. */
export function startTurnPowerLeftPlay(state: CombatState, abilityId: string): boolean {
  const player = state.players.find((candidate) => abilityId.startsWith(`${candidate.id}/power:`))
  if (!player) return false
  const powerKey = abilityId.slice(player.id.length + '/power:'.length)
  const extraAt = powerKey.lastIndexOf(':extra:')
  const powerUid = extraAt < 0 ? powerKey : powerKey.slice(0, extraAt)
  return !player.powers.some((power) => power.uid === powerUid)
}

export function validStartTurnOrder(sources: readonly StartTurnSource[], order: readonly string[]): boolean {
  const expected = new Set(sources.map(({ ability }) => ability.id))
  return order.length === expected.size && new Set(order).size === expected.size &&
    order.every((id) => expected.has(id))
}

/** Ordered Start-of-Turn abilities, with overflow recomputed for that exact order. */
export function startTurnAbilitiesFor(
  state: CombatState,
  sources: readonly StartTurnSource[],
  order?: readonly string[],
  choices: readonly StartTurnChoice[] = [],
): StartTurnAbility[] {
  const ids = order ?? sources.map(({ ability }) => ability.id)
  if (!validStartTurnOrder(sources, ids)) return []
  const byId = new Map(sources.map((entry) => [entry.ability.id, entry]))
  const choiceById = new Map(choices.map((choice) => [choice.id, choice]))
  let plannedState = state
  let plannedShivs = state.players.reduce((sum, player) => sum + player.shivs, 0)
  let planningBlocked = false
  let planningEnded = false
  let forcedCardParked = false
  return ids.map((id) => {
    const entry = byId.get(id)!
    if (planningEnded) return { ...entry.ability, targets: undefined, overflowShivs: 0 }
    const readPlayer = findPlayer(plannedState, entry.ability.playerId)!
    const parkedByEarlier = forcedCardParked
    if (readPlayer.dead) return {
      id: entry.ability.id,
      playerId: entry.ability.playerId,
      label: entry.ability.label,
      overflowShivs: 0,
    }
    // Slayer Pack: Planned behind an ability that takes this Power out of play.
    if (entry.source?.powerUid && !readPlayer.powers.some((power) => power.uid === entry.source!.powerUid)) {
      return { ...entry.ability, targets: undefined, players: undefined, overflowShivs: 0 }
    }
    const choice = choiceById.get(id)
    if (!entry.source) {
      if (entry.guardianModeShiftPlayerId && choice?.guardianModeShift) {
        const simulationState = clone(plannedState)
        const planningPlayer = findPlayer(simulationState, entry.ability.playerId)!
        planningPlayer.guardianMode = shiftGuardianMode(planningPlayer.guardianMode!)
        plannedState = simulationState
      }
      if (!planningBlocked && entry.enemyUid &&
        plannedState.enemies.some((candidate) => candidate.uid === entry.enemyUid)) {
        const simulationState = clone(plannedState)
        const enemy = simulationState.enemies.find((candidate) => candidate.uid === entry.enemyUid)!
        if (entry.enemyAction) applyEnemyAction(simulationState, enemy, entry.enemyAction)
        else enemy.block = gainBlock(enemy.block, entry.enemyBlock ?? 0)
        plannedState = simulationState
      }
      return { ...entry.ability, overflowShivs: 0 }
    }
    const players = entry.ability.players
      ? plannedState === state ? entry.ability.players
        : startTurnTriggerPlayers(plannedState, readPlayer, entry.source)
      : undefined
    const playerTargetStale = Boolean(players &&
      !players.some((candidate) => candidate.id === choice?.targetPlayerId))
    if (playerTargetStale) planningBlocked = true
    const shivs = entry.source.effects.reduce((sum, effect) => sum + (
      effect.kind === 'gainShiv' && effectIsActive(effect, plannedState, readPlayer) ? effect.amount : 0
    ), 0)
    const gained = Math.min(Math.max(0, CAPS.shivs - plannedShivs), shivs)
    const overflowShivs = shivs - gained
    plannedShivs += gained
    const targets = entry.ability.targets
      ? plannedState === state ? entry.ability.targets
        : startTurnTriggerTargets(plannedState, readPlayer, entry.source!)
      : undefined
    const enemyTargetStale = Boolean(targets?.length && choice?.enemyUid !== undefined &&
      !targets.some((target) => target.uid === choice.enemyUid))
    if (entry.ability.targets && targets!.length > 0 &&
      (choice?.enemyUid === undefined || enemyTargetStale)) planningBlocked = true
    let simulationState: CombatState | undefined
    let planningPlayer = readPlayer
    const ensureSimulation = () => {
      if (!simulationState) {
        simulationState = clone(plannedState)
        planningPlayer = findPlayer(simulationState, entry.ability.playerId)!
      }
      return simulationState
    }
    const currentState = () => simulationState ?? plannedState
    const targetOptions = () => {
      const enemies = currentState().enemies
      return enemies.filter((enemy) => !enemy.dead)
        .map((enemy) => ({ uid: enemy.uid, label: enemyLabel(enemies, enemy) }))
    }
    let staleShivIndex: number | undefined
    let shivTargets: StartTurnAbility['shivTargets']
    let shivEndedCombat = false
    if (!planningBlocked && overflowShivs > 0) {
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
        const target = currentState().enemies.find((enemy) => !enemy.dead && enemy.uid === uid)
        if (!target) {
          if (targetOptions().length === 0) continue
          staleShivIndex = index
          shivTargets = targetOptions()
          planningBlocked = true
          break
        }
        const sim = ensureSimulation()
        resolveShivAttack(sim, planningPlayer, uid, 1 + planningPlayer.shivDamageBonus,
          { enemyUid: uid, playerId: null })
        if (planningPlayer.dead || targetOptions().length === 0) {
          shivEndedCombat = true
          break
        }
      }
    }
    let evokeChoice: EvokeChoice | undefined
    let evokeTargets: StartTurnAbility['evokeTargets']
    let evokeOrbs: OrbType[] = []
    let evokeTargetIndex: number | undefined
    const evokeTargetless: number[] = []
    let evokePlanComplete = false
    let evokeEndedCombat = false
    let evokePlanOrbs: (OrbType | null)[] | undefined
    if (!planningBlocked) {
      const plan = effectEvokePlan(entry.source.effects, planningPlayer, choice?.evokeSlots ?? [], currentState().die)
      evokeOrbs = plan.chosen
      if (plan.chosen.length > 0 || plan.next) evokePlanOrbs = plan.orbs
      for (let index = 0; index < plan.chosen.length; index++) {
        const orb = plan.chosen[index]
        if (orb === 'frost') continue
        const sim = ensureSimulation()
        const damageTargets = orbDamageTargets(
          sim, planningPlayer, orb!, choice?.evokeEnemyUids?.[index],
        )
        if (!damageTargets && targetOptions().length === 0) {
          // The last enemy fell but its Summons are pending, so the combat goes on with nothing to hit.
          evokeTargetless.push(index)
          continue
        }
        if (!damageTargets) {
          evokeTargetIndex = index
          evokeTargets = orb === 'lightning'
            ? lightningTargetOptions(sim, planningPlayer)
            : targetOptions()
          planningBlocked = true
          break
        }
        for (const target of damageTargets) {
          damageEnemy(sim, target, (orb === 'lightning' ? 2 :
            3 + planningPlayer.powers.length + (planningPlayer.darkOrbEvokeBonus ?? 0)) +
            (planningPlayer.orbEvokeBonus ?? 0))
        }
        if (combatIsOver(sim)) {
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
          evokePlanComplete = true
        }
      }
    }
    if (!planningBlocked && evokePlanComplete) {
      const privateDraw = entry.source.effects.some((effect) =>
        effect.kind === 'draw' || effect.kind === 'drawThenDiscard' || effect.kind === 'discard')
      const forcedDraw = entry.source.effects.some((effect) => effect.kind === 'drawAndPlayFree')
      if (forcedDraw) {
        planningBlocked = true
        forcedCardParked = true
      } else if (!privateDraw) {
        const exact = clone(plannedState)
        const exactPlayer = findPlayer(exact, entry.ability.playerId)!
        if (resolveTriggerSource(exact, exactPlayer, entry.source, {
          shivEnemyUids: choice?.shivEnemyUids,
          enemyUid: choice?.trigger?.enemyUid ?? choice?.enemyUid,
          enemyRow: choice?.trigger?.enemyRow,
          evokeSlots: choice?.evokeSlots,
          evokeEnemyUids: choice?.evokeEnemyUids,
          targetPlayerId: choice?.trigger?.targetPlayerId ?? choice?.targetPlayerId,
          exhaustUids: choice?.exhaustUids,
          hermitContext: choice?.trigger,
        })) {
          plannedState = exact
          if (combatIsOver(exact)) planningEnded = true
          if (planningEnded || exact.startTurnProgress?.forcedCard) planningBlocked = true
        } else {
          planningBlocked = true
        }
      }
    }
    return {
      ...entry.ability, targets, enemyTargetStale, players,
      exhaustCards: entry.source.effects.some((effect) => effect.kind === 'exhaustFromHand')
        ? planningPlayer.hand.length > 0 ? clone(planningPlayer.hand) : undefined
        : undefined,
      overflowShivs: shivEndedCombat ? choice?.shivEnemyUids.length ?? 0 : overflowShivs,
      staleShivIndex, shivTargets,
      evokeChoice, evokeTargets, evokeOrbs, evokeTargetIndex, evokePlanOrbs,
      ...(evokeTargetless.length > 0 ? { evokeTargetless } : {}),
      ...(parkedByEarlier ? { deferredAfterForcedCard: true as const } : {}),
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

export function defaultStartTurnChoicesForOrder(
  state: CombatState,
  order?: readonly string[],
  choicePlayers?: Set<string>,
  enemyTargets?: ReadonlyMap<string, string>,
  committedChoices: readonly StartTurnChoice[] = [],
  knownSources?: readonly StartTurnSource[],
): StartTurnChoice[] {
  const sources = knownSources ?? pendingStartTurnSources(state)
  const committedById = new Map(committedChoices.map((choice) => [choice.id, choice]))
  let lastEnemyUid: string | undefined
  const choices = startTurnAbilitiesFor(state, sources, order).map((ability) => {
    const committed = committedById.get(ability.id)
    return committed ? {
      ...committed,
      shivEnemyUids: [...committed.shivEnemyUids],
      evokeSlots: [...(committed.evokeSlots ?? [])],
      evokeEnemyUids: [...(committed.evokeEnemyUids ?? [])],
    } : {
      id: ability.id,
      enemyUid: enemyTargets?.get(ability.id) ?? ability.targets?.[0]?.uid,
      targetPlayerId: ability.players?.[0]?.id,
      exhaustUids: ability.exhaustCards?.slice(0, 1).map((card) => card.uid),
      guardianModeShift: ability.guardianModeShift ? false : undefined,
      shivEnemyUids: Array(ability.overflowShivs).fill(null),
      evokeSlots: [] as number[],
      evokeEnemyUids: [] as (string | null)[],
    }
  })
  while (true) {
    const abilities = startTurnAbilitiesFor(state, sources, order, choices)
    for (const ability of abilities) if (
      (ability.exhaustCards?.length ?? 0) > 1 || ability.overflowShivs > 0 || ability.guardianModeShift ||
      (ability.targets?.length ?? 0) > 1 || (ability.players?.length ?? 0) > 1 ||
      (ability.evokeChoice?.options.length ?? 0) > 1 || (ability.evokeTargets?.length ?? 0) > 1
    ) choicePlayers?.add(ability.playerId)
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

export function defaultStartTurnChoices(state: CombatState): StartTurnChoice[] {
  return defaultStartTurnChoicesForOrder(state)
}

export function isPostRollStartTurnPotionChoice(
  state: CombatState,
  player: Player,
  potionId: string,
): boolean {
  return canActivatePotion(state, player, potionId)
}

export function isPostRollStartTurnRelicChoice(
  state: CombatState,
  player: Player,
  relicIndex: number,
): boolean {
  return Boolean(player.relics[relicIndex]) &&
    START_TURN_RELIC_ACTIVATIONS.has(downfallRelicBaseId(player.relics[relicIndex]!.defId)) &&
    canActivateRelic(state, player, relicIndex)
}

export function playerHasPostRollStartTurnChoice(state: CombatState, player: Player): boolean {
  return player.potions.some((potionId) =>
    isPostRollStartTurnPotionChoice(state, player, potionId)) || player.relics.some((_relic, relicIndex) =>
    isPostRollStartTurnRelicChoice(state, player, relicIndex))
}

export function hasPostRollStartTurnChoice(state: CombatState): boolean {
  return state.players.some((player) => playerHasPostRollStartTurnChoice(state, player))
}

export function startTurnChoicePending(ability: StartTurnAbility, choice?: StartTurnChoice): boolean {
  return Boolean(ability.targets?.length && (!choice?.enemyUid || ability.enemyTargetStale)) ||
    Boolean(ability.guardianModeShift && typeof choice?.guardianModeShift !== 'boolean') ||
    Boolean(ability.players && !ability.players.some((player) => player.id === choice?.targetPlayerId)) ||
    Boolean(ability.exhaustCards && (choice?.exhaustUids?.length !== 1 ||
      !ability.exhaustCards.some((card) => card.uid === choice.exhaustUids![0]))) ||
    ability.staleShivIndex !== undefined || ability.evokeTargetIndex !== undefined || Boolean(ability.evokeChoice)
}

/**
 * Whether start-of-turn resolution contains an order, target, overflow, or Orb
 * decision — and so whether the table has to be stopped to make it.
 */
export function startTurnOrderChoicePlayerIdWithResolver(
  state: CombatState,
  resolveStart: (state: CombatState, choices: readonly StartTurnChoice[]) => CombatState,
  knownAbilities?: readonly StartTurnAbility[],
  knownSources?: readonly StartTurnSource[],
): string | undefined {
  if (knownAbilities && knownAbilities.length < 2) return undefined
  const entries = knownSources ?? pendingStartTurnSources(state)
  const abilities = knownAbilities ?? startTurnAbilitiesFor(state, entries)
  if (abilities.length < 2) return undefined
  const entriesById = new Map(entries.map((entry) => [entry.ability.id, entry]))
  const sources = new Map(entries.map((entry) => [entry.ability.id, entry.source]))
  const candidateIds = new Set<string>()
  let definiteOrderOwner: string | undefined
  let hasOrbChoice = false
  for (const entry of entries) if (!entry.source) candidateIds.add(entry.ability.id)
  const effectKinds = (effects: readonly Effect[]): string[] => effects.flatMap((effect): string[] => [
    effect.kind,
    ...(effect.kind === 'sequence' ? effectKinds(effect.effects) : []),
    ...(effect.kind === 'branch' ? effectKinds([...effect.effects, ...effect.otherwise]) : []),
  ])
  const draws = (kind: string) => kind === 'draw' || kind === 'drawThenDiscard' || kind === 'drawAndPlayFree'
  const reactionEvents = new Map<string, TriggerEvent['kind'][]>([
    ['draw', ['onDraw', 'onShuffle']],
    ['drawThenDiscard', ['onDraw', 'onShuffle', 'onDiscard']],
    ['drawAndPlayFree', ['onDraw', 'onShuffle', 'onPlayCard']],
    ['block', ['onGainBlock']],
    ['blockChoices', ['onGainBlock']],
    ['discard', ['onDiscard']],
    ['discardAny', ['onDiscard']],
    ['discardNonRetain', ['onDiscard']],
    ['discardHand', ['onDiscard']],
    ['countdownExhaust', ['onExhaust']],
    ['exhaustFromHand', ['onExhaust']],
    ['exhaustAny', ['onExhaust']],
    ['exhaustHand', ['onExhaust']],
    ['exhaustDrawTop', ['onExhaust']],
    ['exhaustDrawPile', ['onExhaust']],
    ['rainOfGoop', ['onExhaust']],
    ['advance', ['onAdvance']],
    ['retract', ['onRetract']],
    ['enterStance', ['onEnterStance']],
    ['useAllSoulburn', ['onUseSoulburn']],
    ['scry', ['onScry']],
    ['poison', ['onApplyPoison', 'onPutEnemyToken']],
    ['poisonChoices', ['onApplyPoison', 'onPutEnemyToken']],
    ['applyWeak', ['onPutEnemyToken']],
    ['weakChoices', ['onPutEnemyToken']],
    ['applyVulnerable', ['onPutEnemyToken']],
    ['vulnerableChoices', ['onPutEnemyToken']],
  ])
  const pileWriterKinds = new Set([
    'addDaze', 'topdeck', 'recoverDiscard', 'recoverExhaustToDraw', 'recoverExhaustToDiscard',
    'recoverDiscardTopCosts', 'recoverAllDiscardCosts', 'exhaustDrawTop', 'exhaustDrawPile',
    // Slayer Pack: Magnetism takes from the discard pile a draw could reshuffle.
    'mayReturnDiscardTop',
  ])
  for (const player of state.players) {
    const owned = abilities.flatMap((ability) => {
      const source = sources.get(ability.id)
      return ability.playerId === player.id && source ? [{ id: ability.id, source }] : []
    })
    hasOrbChoice ||= effectEvokePlan(owned.flatMap(({ source }) => source.effects), player, [], state.die).next !== null
    const kinds = owned.map(({ source }) => new Set(effectKinds(source.effects)))
    const distinct = (left: (kind: string) => boolean, right: (kind: string) => boolean) =>
      kinds.some((first, index) => [...first].some(left) &&
        kinds.some((second, other) => other !== index && [...second].some(right)))
    const drawableCards = player.draw.length + player.discard.length
    const canDraw = drawableCards > 0
    const consumesHand = (kind: string) => kind === 'discard' || kind === 'exhaustFromHand' ||
      kind === 'load' && player.chamber.length < player.chamberSlots ||
      kind === 'drawThenDiscard' && player.hand.length + drawableCards > 1
    const handInteraction = kinds.some((first, index) => kinds.some((second, other) => other !== index &&
      [...first].some(draws) && [...second].some(consumesHand) &&
      !(first.size === 1 && second.size === 1 && first.has('drawThenDiscard') && second.has('drawThenDiscard'))))
    // Private possibilities cannot be proven by one arbitrary default card.
    if (canDraw && handInteraction) return player.id

    const handCounts = new Set([
      'cardsInHand', 'retainCardsInHand', 'strikesInHand', 'skillsInHand', 'attacksInHand',
      'otherAttacksInHand', 'cursesInHandAndChamber', 'starterCardsInHandAndChamber', 'otherCardsInHand',
    ])
    const amountReadsHand = (amount: unknown) => typeof amount === 'object' && amount !== null &&
      'per' in amount && typeof amount.per === 'string' && handCounts.has(amount.per)
    const effectsReadHand = (effects: readonly Effect[]): boolean => effects.some((effect) =>
      'amount' in effect && amountReadsHand(effect.amount) ||
      'times' in effect && amountReadsHand(effect.times) ||
      effect.kind === 'sequence' && effectsReadHand(effect.effects) ||
      effect.kind === 'branch' && (effectsReadHand(effect.effects) || effectsReadHand(effect.otherwise)))
    const handReaders = owned.map(({ source }) => effectsReadHand(source.effects))
    const handWriters = kinds.map((set) => [...set].some((kind) => draws(kind) || consumesHand(kind)))
    if (handReaders.some((reads, index) => reads && handWriters.some((writes, other) => writes && other !== index))) {
      owned.forEach(({ id }, index) => {
        if (handReaders[index] || handWriters[index]) candidateIds.add(id)
      })
    }
    const sourceDiscards = owned.map(({ source }) => source.effects.some((effect) =>
      effect.kind === 'sequence' && effect.guardianAction === 'card'))
    const pileWriters = kinds.map((set, index) => sourceDiscards[index] ||
      [...set].some((kind) => pileWriterKinds.has(kind)))
    const drawWriters = kinds.map((set) => [...set].some(draws))
    if (pileWriters.some((writes, index) => writes && drawWriters.some((drawsCards, other) =>
      drawsCards && other !== index))) {
      owned.forEach(({ id }, index) => {
        if (pileWriters[index] || drawWriters[index]) candidateIds.add(id)
      })
    }
    const drawTypes = ['attack', 'skill', 'power', 'slime', 'curse', 'status'] as const
    const reactsTo = (reactor: Player, kind: TriggerEvent['kind']) => kind === 'onDraw'
      ? drawTypes.some((cardType) => triggerSources(reactor, { kind, cardType }).length > 0)
      : kind === 'onEnterStance'
        ? (['neutral', 'calm', 'wrath'] as const)
          .some((stance) => triggerSources(reactor, { kind, stance }).length > 0)
        : triggerSources(reactor, { kind } as TriggerEvent).length > 0
    owned.forEach(({ id }, index) => {
      if (kinds[index]!.has('countdownExhaust') ||
        [...kinds[index]!].some((kind) => reactionEvents.get(kind)?.some((event) =>
          state.players.some((reactor) => reactsTo(reactor, event))))) candidateIds.add(id)
    })

    const inGroup = (...group: string[]) => (kind: string) => group.includes(kind)
    const strengthBeforeHit = distinct(inGroup('gainStrength', 'gainTemporaryStrength', 'doubleStrength'),
      inGroup('hit', 'rowHit', 'hitChoices'))
    if (strengthBeforeHit) definiteOrderOwner ??= player.id
    const possible = canDraw && kinds.some((set) => set.has('drawAndPlayFree')) && owned.length > 1 ||
      distinct(inGroup('setNextCardCost'), inGroup('setNextCardCost')) ||
      distinct(inGroup('advance', 'retract', 'branch'), inGroup('advance', 'retract', 'branch')) ||
      distinct(inGroup('load', 'discountChamber', 'discardChamber', 'playChamber'),
        inGroup('load', 'discountChamber', 'discardChamber', 'playChamber')) ||
      distinct(inGroup('growSlime', 'commandSlime', 'gainSlimeVigor', 'tapSlime', 'rainOfGoop'),
        inGroup('growSlime', 'commandSlime', 'gainSlimeVigor', 'tapSlime', 'rainOfGoop')) ||
      strengthBeforeHit ||
      distinct(inGroup('channel'), inGroup('countdownExhaust')) ||
      distinct(inGroup('sequence'), inGroup('sequence')) ||
      canDraw && kinds.some((set) => [...set].some(draws)) &&
        player.powers.some((power) => cardDef(power.defId).trigger?.kind === 'onDraw') && owned.length > 1
    if (possible) for (const { id } of owned) candidateIds.add(id)
  }
  const enemyAffecting = abilities.filter((ability) => {
    const source = sources.get(ability.id)
    const player = findPlayer(state, ability.playerId)
    return Boolean(entriesById.get(ability.id)?.enemyUid ||
      source && player && source.effects.some((effect) => reachesEnemy(effect, player)))
  })
  if (enemyAffecting.length > 0 && abilities.length > 1) {
    for (const ability of enemyAffecting) candidateIds.add(ability.id)
  }
  const drawing = abilities.filter((ability) => {
    const source = sources.get(ability.id)
    const player = findPlayer(state, ability.playerId)
    return source && player && player.draw.length + player.discard.length > 0 &&
      effectKinds(source.effects).some(draws)
  })
  if (abilities.length > 1) for (const ability of drawing) {
    const source = sources.get(ability.id)
    if (source && effectKinds(source.effects).includes('drawAndPlayFree')) candidateIds.add(ability.id)
  }
  const drawingKinds = new Set(drawing.map((ability) =>
    `${ability.playerId}:${JSON.stringify(sources.get(ability.id)?.effects ?? [])}`))
  if (drawing.length > 1 && drawingKinds.size > 1) {
    for (const ability of drawing) candidateIds.add(ability.id)
  }
  const enemyReactiveDraws = drawing.filter((ability) => {
    const player = findPlayer(state, ability.playerId)
    return player && triggerSources(player, { kind: 'onDraw' })
      .some((source) => source.effects.some((effect) => reachesEnemy(effect, player)))
  })
  if (enemyReactiveDraws.length > 0 && enemyAffecting.length > 0) {
    for (const ability of [...enemyReactiveDraws, ...enemyAffecting]) candidateIds.add(ability.id)
  }
  const sharedTokenSources = abilities.filter((ability) => {
    const source = sources.get(ability.id)
    return source && effectKinds(source.effects).some((kind) => kind === 'gainShiv' || kind === 'gainMiracle')
  })
  if (sharedTokenSources.length > 1) for (const ability of sharedTokenSources) candidateIds.add(ability.id)
  if (candidateIds.size === 0) return undefined
  if (definiteOrderOwner) return definiteOrderOwner
  const sourceSignatures = abilities.map((ability): string | null => {
    const source = sources.get(ability.id)
    return source ? `${ability.playerId}:${JSON.stringify([
      source.effects,
      source.scope,
      source.supportScope,
      source.presentationSourceId,
      source.oncePerTurn,
      source.powerUid,
    ])}` : null
  })
  if (sourceSignatures.every((signature) => signature !== null) && new Set(sourceSignatures).size === 1) {
    return undefined
  }
  if (abilities.length > 2 && enemyAffecting.length > 1 &&
    (drawing.length > 0 || hasOrbChoice)) {
    return abilities.find((ability) => candidateIds.has(ability.id))?.playerId
  }
  const maxExactAbilities = 4
  if (abilities.length > maxExactAbilities) {
    return abilities.find((ability) => candidateIds.has(ability.id))?.playerId
  }
  const order = abilities.map((ability) => ability.id)
  const maxExactSimulations = abilities.length <= 2 ? Number.POSITIVE_INFINITY : 32
  let simulations = 0
  type OrderOutcome = { resolved: CombatState; choicePlayers: string[] }
  const outcome = (ids: readonly string[], targets?: ReadonlyMap<string, string>): OrderOutcome => {
    simulations += 1
    const choicePlayers = new Set<string>()
    const resolved = resolveStart(state,
      defaultStartTurnChoicesForOrder(state, ids, choicePlayers, targets, [], entries))
    return { resolved, choicePlayers: [...choicePlayers].sort() }
  }
  const outcomesEqual = (left: OrderOutcome, right: OrderOutcome): boolean => {
    if (left.choicePlayers.length !== right.choicePlayers.length) return false
    for (let index = 0; index < left.choicePlayers.length; index++) {
      if (left.choicePlayers[index] !== right.choicePlayers[index]) return false
    }
    return gameplayStatesEqual(left.resolved, right.resolved)
  }
  const canonical = outcome(order)
  for (const id of candidateIds) {
    const from = order.indexOf(id)
    for (let to = 0; to < order.length; to++) {
      if (to === from) continue
      if (simulations >= maxExactSimulations) {
        return abilities.find((ability) => candidateIds.has(ability.id))?.playerId
      }
      const moved = order.filter((candidate) => candidate !== id)
      moved.splice(to, 0, id)
      if (!outcomesEqual(outcome(moved), canonical)) return abilities.find((ability) => ability.id === id)?.playerId
      const focus = enemyAffecting.find((ability) => ability.id === id)
      if (!focus) continue
      for (const other of enemyAffecting) {
        if (other.id === id || (focus.targets?.length ?? 0) < 2 && (other.targets?.length ?? 0) < 2) continue
        for (const left of focus.targets ?? []) for (const right of other.targets ?? []) {
          if (simulations + 2 > maxExactSimulations) return focus.playerId
          const targets = new Map([[focus.id, left.uid], [other.id, right.uid]])
          if (!outcomesEqual(outcome(moved, targets), outcome(order, targets))) return focus.playerId
        }
      }
    }
  }
  return undefined
}
