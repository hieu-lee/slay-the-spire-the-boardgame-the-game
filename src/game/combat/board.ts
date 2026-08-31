// Reading the board. Who is where, what a printed target scope resolves to on
// this arrangement of rows, and whether the fight is already decided.
//
// Nothing here writes to the state — `clone` is the one exception, and it only
// copies. Everything above this layer answers "what changes" by first asking
// this layer "what is there".
import type { CombatState, EndTurnAbility, PlayContext } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { Effect, TargetScope } from '../cards.ts'
import { enemyDef } from '../enemies.ts'
import type { Enemy, OrbType, Player } from '../types.ts'

export const clone = <T,>(value: T): T => structuredClone(value)

export function livingEnemies(state: CombatState): Enemy[] {
  return state.enemies.filter((enemy) => !enemy.dead)
}

export function findPlayer(state: CombatState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId)
}

/** Public remaining HP-loss allowance from Apparition and persistent Powers. */
export function remainingRoundHpLoss(player: Player): number | undefined {
  const powerLimit = player.powers.flatMap((held) =>
    faceOf(cardDef(held.defId), held.upgraded).persistentEffects ?? [])
    .filter((effect): effect is Extract<Effect, { kind: 'limitRoundHpLoss' }> =>
      effect.kind === 'limitRoundHpLoss')
    .reduce<number | undefined>((limit, effect) => Math.min(limit ?? effect.amount, effect.amount), undefined)
  const limit = powerLimit === undefined
    ? player.hpLossLimitThisRound
    : Math.min(player.hpLossLimitThisRound ?? powerLimit, powerLimit)
  return limit === undefined ? undefined : Math.max(0, limit - (player.hpLostThisRound ?? 0))
}

export function combatRows(state: CombatState): number[] {
  return [...new Set([
    ...state.players.map((player) => player.row),
    ...state.enemies.filter((enemy) => !enemy.isBoss).map((enemy) => enemy.row),
  ])].sort((a, b) => a - b)
}

export function combatRowLabel(state: Pick<CombatState, 'players'>, row: number): string {
  const playerIndex = state.players.findIndex((candidate) => candidate.row === row)
  if (playerIndex < 0) return `Row ${row + 1}`
  const character = state.players[playerIndex]!.character
  const label = `${character.charAt(0).toUpperCase()}${character.slice(1)}`
  const duplicateCharacter = state.players.some((candidate, index) =>
    index !== playerIndex && candidate.character === character)
  return `Row ${label}${duplicateCharacter ? ` (Player ${playerIndex + 1})` : ''}`
}

export function rowExists(state: CombatState, row: unknown): row is number {
  return Number.isInteger(row) && combatRows(state).includes(row as number)
}

export const lightningRowTarget = (row: number): string => `row:${row}`

export function lightningRowFromTarget(target: unknown): number | null {
  if (typeof target !== 'string' || !target.startsWith('row:')) return null
  const row = Number(target.slice(4))
  return Number.isInteger(row) && lightningRowTarget(row) === target ? row : null
}

export function lightningTargetsRows(
  actor: Pick<Player, 'powers'>,
  sourceCardId?: string,
): boolean {
  return sourceCardId === 'electrodynamics' || actor.powers.some((power) =>
    faceOf(cardDef(power.defId), power.upgraded).effects.some((effect) => effect.kind === 'lightningTargetsRow'))
}

export function lightningTargetOptions(
  state: CombatState,
  actor: Pick<Player, 'powers'>,
  sourceCardId?: string,
): NonNullable<EndTurnAbility['targets']> {
  if (!lightningTargetsRows(actor, sourceCardId)) {
    return livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
  }
  const boss = livingEnemies(state).find((enemy) => enemy.isBoss)
  return [...combatRows(state).map((row) => ({
    uid: lightningRowTarget(row),
    label: `${combatRowLabel(state, row)}${boss ? ' + boss' : ''}`,
  })), ...(boss ? [{ uid: boss.uid, label: enemyLabel(state.enemies, boss) }] : [])]
}

export function lightningDamageTargets(
  state: CombatState,
  actor: Pick<Player, 'powers'>,
  target: string | null | undefined,
  sourceCardId?: string,
): Enemy[] | null {
  if (lightningTargetsRows(actor, sourceCardId)) {
    const row = lightningRowFromTarget(target)
    if (row !== null && rowExists(state, row)) return resolveEnemyTargets(state, 'row', null, row)
    const boss = livingEnemies(state).find((enemy) => enemy.uid === target && enemy.isBoss)
    if (!boss) return null
    const rows = [...new Set(livingEnemies(state).filter((enemy) => !enemy.isBoss).map((enemy) => enemy.row))]
    return rows.length === 1 ? resolveEnemyTargets(state, 'row', null, rows[0]) : [boss]
  }
  const enemy = livingEnemies(state).find((candidate) => candidate.uid === target)
  return enemy ? [enemy] : null
}

export function orbDamageTargets(
  state: CombatState,
  actor: Pick<Player, 'powers'>,
  orb: Exclude<OrbType, 'frost'>,
  target: string | null | undefined,
  sourceCardId?: string,
): Enemy[] | null {
  if (orb === 'lightning') return lightningDamageTargets(state, actor, target, sourceCardId)
  const enemy = livingEnemies(state).find((candidate) => candidate.uid === target)
  return enemy ? [enemy] : null
}

/** Enemies a scope resolves to. A row always includes the boss (p.15). */
export function resolveEnemyTargets(
  state: CombatState,
  scope: TargetScope,
  chosenUid: string | null,
  chosenRow?: number | null,
): Enemy[] {
  const alive = livingEnemies(state)
  if (scope === 'allEnemies') return alive
  if (scope === 'row') {
    if (chosenRow !== null && chosenRow !== undefined) {
      return alive.filter((enemy) => enemy.row === chosenRow || enemy.isBoss)
    }
    const anchor = alive.find((enemy) => enemy.uid === chosenUid)
    if (!anchor) return []
    return alive.filter((enemy) => enemy.row === anchor.row || enemy.isBoss)
  }
  const single = alive.find((enemy) => enemy.uid === chosenUid)
  return single ? [single] : []
}

/**
 * What to call an enemy in the log.
 *
 * A four-player board routinely spawns two of the same creature, and "Cultist
 * is dead" then names a tile nobody can identify. The row disambiguates only
 * when it needs to, so a single Cultist stays "Cultist".
 */
export function enemyLabel(enemies: readonly Enemy[], enemy: Enemy): string {
  const name = enemyDef(enemy.defId, enemy.ascension).name
  const sameName = enemies.filter((other) => enemyDef(other.defId).name === name)
  if (sameName.length <= 1) return name
  const sameRow = sameName.filter((other) => other.row === enemy.row)
  // The row is the natural way to tell two of a creature apart, but a row card
  // routinely puts both of them in the SAME row -- and then both print
  // "Cultist (row 1)" and the log reads as striking a corpse. Fall back to a
  // position within the row, which is the only thing left that separates them.
  if (sameRow.length <= 1) return `${name} (row ${enemy.row + 1})`
  return `${name} (row ${enemy.row + 1}, #${sameRow.findIndex((other) => other.uid === enemy.uid) + 1})`
}

/**
 * Who a supportive effect lands on.
 *
 * The card-level `supportTarget` says the card asks you to choose an ally; the
 * effect's own `toChosen` says whether THIS clause is the one that goes to
 * them. Splitting the two is what keeps "2 Block to any player. Enter Calm."
 * from handing the Watcher's stance to somebody else.
 */
export function supportTargets(
  state: CombatState,
  effect: { toChosen?: boolean },
  supportScope: TargetScope,
  context: PlayContext,
  actor: Player,
): Player[] {
  if (!effect.toChosen) return [actor]
  return resolvePlayerTargets(state, supportScope, context.playerId, actor)
}

function resolvePlayerTargets(
  state: CombatState,
  scope: TargetScope,
  chosenId: unknown,
  actor: Player,
): Player[] {
  if (scope === 'allPlayers') return state.players.filter((player) => !player.dead)
  if (scope === 'anyPlayer') {
    if (chosenId === null) return [actor]
    const chosen = typeof chosenId === 'string' ? findPlayer(state, chosenId) : undefined
    return chosen && !chosen.dead ? [chosen] : []
  }
  return [actor]
}

export const powerAbilityKey = (playerId: string, powerUid: string): string =>
  `${playerId}/power:${powerUid}`

export function powerAbilityUsed(state: CombatState, playerId: string, powerUid: string): boolean {
  return state.powerTriggersUsedThisTurn.includes(powerAbilityKey(playerId, powerUid))
}

const loopOrbTarget = (slot: number): string => `orb:${slot}`

export function parseLoopOrbTarget(value: string | undefined): { slot: number; enemyUid: string | null } | undefined {
  if (value === undefined) return undefined
  if (value.startsWith('orb:')) {
    const slot = Number(value.slice(4))
    return Number.isInteger(slot) && slot >= 0 && loopOrbTarget(slot) === value ? { slot, enemyUid: null } : undefined
  }
  const colon = value.indexOf(':')
  const slot = Number(value.slice(0, colon))
  if (colon < 1 || !Number.isInteger(slot) || slot < 0) return undefined
  return { slot, enemyUid: value.slice(colon + 1) || null }
}

export function loopOrbTargets(player: Player): EndTurnAbility['targets'] {
  const targets = player.orbs.flatMap((orb, slot) => orb
    ? [{ uid: loopOrbTarget(slot), label: `${orb[0]!.toUpperCase()}${orb.slice(1)} Orb ${slot + 1}` }]
    : [])
  return targets.length > 0 ? targets : undefined
}

export function playersInRowOf(state: CombatState, enemy: Enemy): Player[] {
  // A boss counts as being in EVERY row (docs/rules.md), which is why the
  // player-facing `resolveEnemyTargets` already treats a row as including it.
  // The enemy side did not, so a boss with a single-target attack could only
  // ever reach whichever row it happened to be spawned in.
  if (enemy.isBoss) return state.players.filter((player) => !player.dead)
  const sameRow = state.players.filter((player) => !player.dead && player.row === enemy.row)
  if (sameRow.length > 0 || !state.lastStand || !state.enemies.some((candidate) => candidate.isBoss) ||
    !state.players.some((player) => player.dead && player.row === enemy.row)) return sameRow
  const living = state.players.filter((player) => !player.dead)
  const below = living.filter((player) => player.row < enemy.row)
  const above = living.filter((player) => player.row > enemy.row)
  const targetRow = below.length > 0
    ? Math.max(...below.map((player) => player.row))
    : above.length > 0 ? Math.min(...above.map((player) => player.row)) : undefined
  if (targetRow === undefined) return []
  return living.filter((player) => player.row === targetRow)
}

/**
 * Whether either ending has already happened.
 *
 * Both are normally immediate (p.13), so anything still queued behind them —
 * another player's orb, their Wrath bite, the next enemy in the order — must
 * not resolve at all. The optional Last Stand rule (p.23) replaces one player
 * death with the whole party dying during a Boss fight.
 */
export function lastStandActive(state: CombatState): boolean {
  return state.lastStand && state.enemies.some((enemy) => enemy.isBoss)
}

export function combatIsOver(state: CombatState): boolean {
  const lastStand = lastStandActive(state)
  return (state.enemies.every((enemy) => enemy.dead) && state.pendingSummons.length === 0) ||
    (lastStand ? state.players.every((player) => player.dead) : state.players.some((player) => player.dead))
}

export function cardResolutionIsOver(state: CombatState, context: PlayContext, actor: Player): boolean {
  return actor.dead || combatIsOver(state) && (context.pendingEnemyDeathUids?.length ?? 0) === 0
}
