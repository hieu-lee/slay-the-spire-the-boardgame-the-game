// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".
import { cardCost, faceOf, cardDef } from './cards.ts'
import type { Amount, CardDef, Condition, CountOf, Effect, TargetScope } from './cards.ts'
import { actionsFor, actionsForEnemy, advanceCube, drawSummon, enemyAbilities, enemyDef, startingHp } from './enemies.ts'
import type { EnemyAction, SummonSupply } from './enemies.ts'
import {
  applyDamage,
  applyHpLoss,
  attackerModsOfEnemy,
  attackerModsOfPlayer,
  gainBlock,
  gainPoison,
  gainStrength,
  gainVulnerable,
  gainWeak,
  hitDamage,
  totalPoisonInPlay,
} from './damage.ts'
import { addToDiscardTop, addToDrawTop, drawCards, discardHand, scry } from './piles.ts'
import { potionDef, relicAbilities, relicDef } from './relics.ts'
import { triggerMatches } from './triggers.ts'
import type { Trigger, TriggerEvent } from './triggers.ts'
import { nextInt, shuffle } from './rng.ts'
import type { RngState } from './rng.ts'
import { CAPS } from './types.ts'
import type { CardInstance, CardType, Enemy, OrbType, Player } from './types.ts'

export type CombatPhase =
  /** Reset, draw, and roll are done; ordered Start-of-Turn abilities remain. */
  | 'start'
  | 'player'
  | 'copy'
  | 'discard'
  | 'enemy'
  /** The Enemy Turn is done and the next Start of Turn has not been taken. */
  | 'roundEnd'
  | 'won'
  | 'lost'

export type CombatState = {
  /** Stable room-scoped identity used to reject delayed actions from an earlier fight. */
  combatId: string
  /** Optional p.23 rule; it changes deaths only while a Boss is in this fight. */
  lastStand: boolean
  rng: RngState
  turn: number
  /** One shared die roll drives every die effect for the whole round (p.12). */
  die: number
  phase: CombatPhase
  players: Player[]
  enemies: Enemy[]
  summonSupply: SummonSupply
  pendingSummons: {
    sourceUid: string
    row: number
    defIds: string[]
    turn: number
    timing?: 'startOfTurn' | 'endOfTurn'
    direct?: boolean
    isBoss?: boolean
    strength?: number
    strengthDefId?: string
    strengthPerPower?: boolean
  }[]
  /** Face-down physical potion deck. Never included in a client snapshot. */
  potionDeck: string[]
  potionLimit: 2 | 3
  discardedThisTurn: string[]
  stanceChangedThisTurn: string[]
  /** Power instance ids already spent by a printed once-per-turn ability or trigger. */
  powerTriggersUsedThisTurn: string[]
  /** Facing is resolved after ordinary Start-of-Turn abilities. */
  startTurnStage?: 'effects' | 'facing'
  /** Triggered abilities waiting for earlier card text or a row choice. */
  pendingTriggers: PendingTrigger[]
  nextTriggerId: number
  /** End-of-turn abilities waiting for a mandatory nested trigger. */
  endTurnProgress?: { order: EndTurnOrder }
  /** Unresolved Start-of-Turn work, including Mayhem's private forced play. */
  startTurnProgress?: {
    choices: StartTurnChoice[]
    /** Private Scry abilities that must finish after Reset and before Draw. */
    beforeDraw?: {
      drewFrom: number
      sources: { playerId: string; sourceId: string }[]
      ordered: boolean
    }
    /** The Draw step paused on a trigger before the shared die was rolled. */
    rollPending?: { drewFrom: number }
    /** Tools of the Trade drew; only its owner may choose the card to discard. */
    discard?: { playerId: string; sourceId: string; pendingTriggers: PendingTrigger[] }
    forcedCard?: {
      playerId: string
      cardUid: string | null
      sourceCardId: string
      sourceLabel?: string
      exhaustNonPower: boolean
      /** Draw reactions waiting for the forced card and its parent Havoc to finish. */
      pendingTriggers?: PendingTrigger[]
      /** Havoc cards waiting for their immediately-played child to finish. */
      deferredHavocs?: DeferredHavoc[]
    }
  }
  /** Physical cards waiting to resolve after their virtual copy. */
  pendingCardCopy?: {
    playerId: string
    card: CardInstance
    energySpent: number
    resumePhase: 'start' | 'player'
    forcedExhaust: boolean
    forcedChoices: StartTurnChoice[] | null
    deferredHavocs: DeferredHavoc[]
    /** Parent-card triggers waiting for this nested copy to finish. */
    deferredTriggers?: PendingTrigger[]
    /** The sole play-twice effect applied to this card. */
    sourceNames: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Omniscience' | 'Weave')[]
    /** Doppelganger queues only a virtual card, with no physical original to clean up. */
    virtualOnly?: boolean
    /** Additional physical Weaves discarded by the same Scry, in reveal order. */
    queuedWeaves?: CardInstance[]
    /** Next-card modifiers consumed only if this queued card is allowed to play. */
    queuedCopySources?: CopySource[]
    consumeFreeCard?: boolean
    consumeFreeAttack?: boolean
  }
  /** Distilled Chaos cards are private until their owner plays each for free. */
  pendingDistilled?: { playerId: string; cards: CardInstance[] }
  /** Golden Eye's private top-three reveal, persisted across reconnects. */
  pendingRelicScry?: { playerId: string; relicIndex: number; cards: CardInstance[] }
  /** Ordered public Attack/Skill plays used by Doppelganger this turn. */
  playedCardsThisTurn: { playerId: string; card: CardInstance; copied: boolean }[]
  /** Recent public actions for player-facing animation; reconnecting clients baseline the sequence. */
  presentationEvents: CombatPresentationEvent[]
  log: string[]
}

type PresentationTargets = {
  seq: number
  actorId: string
  sourceId: string
  enemyIds: string[]
  playerIds: string[]
  enemyRow?: number
}

export type CombatPresentationEvent = PresentationTargets & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
)

type NewPresentationEvent = Omit<PresentationTargets, 'seq'> & (
  | { kind: 'card'; upgraded: boolean; copied: boolean; energy: number; mode?: number }
  | { kind: 'potion' }
  | { kind: 'shiv' }
  | { kind: 'orb'; orb: OrbType }
)

export type PendingTrigger = {
  id: number
  playerId: string
  sourceId: string
  /** Event-bound target, such as the enemy that received a token. */
  enemyUid?: string
}

type CopySource = 'Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Omniscience'
type DeferredHavoc = {
  card: CardInstance
  exhaust: boolean
  /** Printed clauses after a Scry that paused to play Weave. */
  remainingEffects?: Effect[]
  /** A Doppelganger Havoc is virtual and never enters a pile. */
  virtualOnly?: boolean
  /** A copied Havoc waits until its immediate child finishes. */
  copySourceNames?: CopySource[]
  copyResumePhase?: 'start' | 'player'
}

export type DiscardOrders = Readonly<Record<string, readonly string[]>>
export type EndTurnOrder = readonly string[]
export type EndTurnAbility = {
  id: string
  playerId: string | null
  label: string
  targets?: { uid: string; label: string }[]
}

export type StartTurnAbility = {
  id: string
  playerId: string
  label: string
  /** A recurring single-enemy effect still needs its owner to choose. */
  targets?: { uid: string; label: string }[]
  /** A supporting relic may give its effect to any living player. */
  players?: { id: string; label: string }[]
  /** The staged direct target was killed by an earlier ordered ability. */
  enemyTargetStale?: boolean
  /** Shivs this ability cannot take from the shared supply and may throw now. */
  overflowShivs: number
  /** A staged overflow Shiv target was killed by an earlier ordered ability. */
  staleShivIndex?: number
  shivTargets?: { uid: string; label: string }[]
  /** Next full-slot Orb choice after the choices already staged for this ability. */
  evokeChoice?: EvokeChoice
  /** Living enemies after staged Evokes, for the next Lightning/Dark target. */
  evokeTargets?: { uid: string; label: string }[]
  /** Orb type for every staged Evoke application; repeated Evokes repeat the type. */
  evokeOrbs?: OrbType[]
  /** Repeated Evokes remove one Orb but collect one target per application. */
  evokeTargetIndex?: number
}

export type StartTurnChoice = {
  id: string
  enemyUid?: string
  targetPlayerId?: string
  /** One living enemy id or explicit skip per overflow Shiv. */
  shivEnemyUids: (string | null)[]
  /** Chosen Orb slot and Lightning/Dark target for each forced Evoke, in order. */
  evokeSlots?: number[]
  evokeEnemyUids?: (string | null)[]
}

export type StartTurnScryPreview = {
  id: string
  playerId: string
  label: string
  amount: number
  cards: CardInstance[]
}

export type StartTurnScryAbility = Omit<StartTurnScryPreview, 'cards'>

export type StartTurnDiscardPreview = {
  playerId: string
  sourceId: string
  label: string
  cards: CardInstance[]
}

const END_TURN_TARGET = '@'
export const endTurnChoiceId = (choice: string): string => choice.split(END_TURN_TARGET, 1)[0]!
export const endTurnChoiceTarget = (choice: string): string | undefined => choice.split(END_TURN_TARGET)[1]
export const chooseEndTurnTarget = (id: string, targetUid: string): string =>
  `${endTurnChoiceId(id)}${END_TURN_TARGET}${targetUid}`
export const defaultEndTurnOrder = (abilities: readonly EndTurnAbility[]): EndTurnOrder =>
  abilities.map((ability) => ability.targets?.[0]
    ? chooseEndTurnTarget(ability.id, ability.targets[0].uid)
    : ability.id)

const clone = <T,>(value: T): T => structuredClone(value)

const PRESENTATION_EVENT_LIMIT = 12

type PresentationContext = {
  enemyUid?: string | null
  enemyUids?: readonly (string | null)[]
  shivEnemyUids?: readonly (string | null)[]
  evokeEnemyUids?: readonly (string | null)[]
  playerId?: string | null
  playerIds?: readonly string[]
  switchWithPlayerId?: string | null
  enemyRow?: number | null
}

function presentationTargets(
  state: CombatState,
  actorId: string,
  enemyScope: TargetScope,
  supportScope: TargetScope,
  context: PresentationContext,
): Pick<PresentationTargets, 'enemyIds' | 'playerIds' | 'enemyRow'> {
  const scopedEnemies = ['enemy', 'row', 'allEnemies'].includes(enemyScope)
    ? resolveEnemyTargets(state, enemyScope, context.enemyUid ?? null, context.enemyRow)
    : []
  const evokeEnemies = (context.evokeEnemyUids ?? []).flatMap((id) => {
    if (typeof id !== 'string') return []
    const row = lightningRowFromTarget(id)
    return row === null ? [id] : resolveEnemyTargets(state, 'row', null, row).map((enemy) => enemy.uid)
  })
  const enemyIds = [...new Set([
    ...scopedEnemies.map((enemy) => enemy.uid),
    ...(context.enemyUids ?? []),
    ...(context.shivEnemyUids ?? []),
    ...evokeEnemies,
  ].filter((id): id is string => typeof id === 'string'))]
  const scopedPlayers = supportScope === 'allPlayers'
    ? state.players.filter((player) => !player.dead).map((player) => player.id)
    : supportScope === 'anyPlayer' ? [context.playerId ?? actorId] : []
  const playerIds = [...new Set([
    ...scopedPlayers,
    ...(context.playerIds ?? []),
    context.switchWithPlayerId,
  ].filter((id): id is string => typeof id === 'string' && id !== actorId))]
  const enemyRow = typeof context.enemyRow === 'number' && Number.isInteger(context.enemyRow)
    ? context.enemyRow
    : state.enemies.find((enemy) => enemy.uid === context.enemyUid)?.row
  return {
    enemyIds,
    playerIds,
    ...(enemyScope === 'row' && enemyRow !== undefined ? { enemyRow } : {}),
  }
}

function presentationEnemyScope(
  def: CardDef,
  effects: readonly Effect[],
  actor: Player,
  includeEvokes: boolean,
  energySpent: number,
): TargetScope {
  const active = def.modes ? { ...def, modes: undefined, effects: [...effects] } : def
  return cardNeedsEnemy(active, actor, includeEvokes, energySpent) ? def.target ?? 'enemy' : 'self'
}

function presentationCardContext(
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
): PresentationContext {
  return {
    enemyUid: context.enemyUid,
    enemyRow: context.enemyRow,
    enemyUids: cardEnemyChoiceCount(def, context.mode) > 0 ? context.enemyUids : [],
    shivEnemyUids: context.shivEnemyUids,
    evokeEnemyUids: context.evokeEnemyUids,
    playerId: context.playerId,
    playerIds: cardPlayerChoiceCount(def, context.mode) > 0 ? context.playerIds : [],
    switchWithPlayerId: effects.some((effect) => effect.kind === 'switchRows')
      ? context.switchWithPlayerId : undefined,
  }
}

function addPresentationEvent(
  state: CombatState,
  event: NewPresentationEvent,
): void {
  const events = state.presentationEvents ?? []
  const added = {
    seq: (events.at(-1)?.seq ?? 0) + 1,
    ...event,
  } as CombatPresentationEvent
  state.presentationEvents = [...events, added].slice(-PRESENTATION_EVENT_LIMIT)
}

function forgetRetain(card: CardInstance): CardInstance {
  const {
    retainedLastTurn: _retained,
    retainThisTurn: _retain,
    freeThisTurn: _free,
    costReductionThisTurn: _reduction,
    scryDamageBonus: _scryBonus,
    ...rest
  } = card
  return rest
}

export function livingEnemies(state: CombatState): Enemy[] {
  return state.enemies.filter((enemy) => !enemy.dead)
}

function findPlayer(state: CombatState, playerId: string): Player | undefined {
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

function combatRows(state: CombatState): number[] {
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

function rowExists(state: CombatState, row: unknown): row is number {
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

function lightningTargetOptions(
  state: CombatState,
  actor: Pick<Player, 'powers'>,
  sourceCardId?: string,
): NonNullable<EndTurnAbility['targets']> {
  if (!lightningTargetsRows(actor, sourceCardId)) {
    return livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
  }
  const boss = livingEnemies(state).some((enemy) => enemy.isBoss)
  return combatRows(state).map((row) => ({
    uid: lightningRowTarget(row),
    label: `${combatRowLabel(state, row)}${boss ? ' + boss' : ''}`,
  }))
}

function lightningDamageTargets(
  state: CombatState,
  actor: Pick<Player, 'powers'>,
  target: string | null | undefined,
  sourceCardId?: string,
): Enemy[] | null {
  if (lightningTargetsRows(actor, sourceCardId)) {
    const row = lightningRowFromTarget(target)
    return row !== null && rowExists(state, row) ? resolveEnemyTargets(state, 'row', null, row) : null
  }
  const enemy = livingEnemies(state).find((candidate) => candidate.uid === target)
  return enemy ? [enemy] : null
}

function orbDamageTargets(
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

function enemyCannotLoseHp(enemy: Enemy): boolean {
  const immunity = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((ability) => ability.kind === 'immuneOnSlots')
  return immunity?.kind === 'immuneOnSlots' && immunity.slots.includes(enemy.actionIndex)
}

function enemyHpAfterLoss(state: CombatState, enemy: Enemy, hp: number): number {
  if (enemyCannotLoseHp(enemy)) return enemy.hp
  const invincible = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((ability) => ability.kind === 'invincible')
  if (invincible?.kind !== 'invincible' || enemy.abilityUsed) return hp
  return Math.max(hp, invincible.hpPerPlayer * state.players.length)
}

function loseEnemyHp(state: CombatState, enemy: Enemy, amount: number): { hp: number; hpLost: number } {
  const outcome = applyHpLoss(enemy.hp, amount)
  const hp = enemyHpAfterLoss(state, enemy, outcome.hp)
  return { hp, hpLost: enemy.hp - hp }
}

/** Deals `damage` to an enemy, spending Block and firing Curl Up immediately. */
function damageEnemy(
  state: CombatState,
  enemy: Enemy,
  damage: number,
  deferAbilities = false,
): { blocked: number; curled: boolean; hpLost: number } {
  const hpBefore = enemy.hp
  const blockBefore = enemy.block
  const outcome = applyDamage(enemy.block, enemy.hp, damage)
  enemy.block = outcome.block
  enemy.hp = enemyHpAfterLoss(state, enemy, outcome.hp)
  if (enemy.hp === 0) enemy.dead = true
  const ability = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((candidate) => candidate.kind === 'curlUp')
  if (
    !deferAbilities && enemy.hp < hpBefore && !enemy.dead && !enemy.abilityUsed && ability?.kind === 'curlUp'
  ) {
    enemy.abilityUsed = true
    enemy.block = gainBlock(enemy.block, ability.block)
    return { blocked: blockBefore - outcome.block, curled: true, hpLost: hpBefore - enemy.hp }
  }
  return { blocked: blockBefore - outcome.block, curled: false, hpLost: hpBefore - enemy.hp }
}

function grantShiftBlock(state: CombatState, enemy: Enemy, amount: number): void {
  if (amount <= 0) return
  for (const player of playersInRowOf(state, enemy)) {
    const before = player.block
    player.block = gainBlock(player.block, amount)
    if (player.block > before) state.log = [...state.log,
      `${enemyLabel(state.enemies, enemy)}'s Shift gave ${player.name} ${player.block - before} Block`]
  }
}

function triggerAngry(state: CombatState, enemy: Enemy, damagingHits: number): void {
  const ability = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    .find((candidate) => candidate.kind === 'angry')
  if (enemy.dead || damagingHits === 0 || ability?.kind !== 'angry') return
  const before = enemy.strength
  enemy.strength = gainStrength(enemy.strength, ability.strength * damagingHits)
  if (enemy.strength > before) state.log = [...state.log,
    `${enemyLabel(state.enemies, enemy)}'s Angry gained ${enemy.strength - before} Strength`]
}

/** Adds Poison through the shared cube cap. */
function putPoison(state: CombatState, target: Enemy, amount: number): number {
  if (target.dead) return 0
  const before = target.poison
  target.poison = gainPoison(target.poison, amount, totalPoisonInPlay(state.enemies))
  return target.poison - before
}

function poisonApplied(state: CombatState, actor: Player, context: PlayContext): void {
  if (context.pendingPoisonTriggers) context.pendingPoisonTriggers.push(actor.id)
  else fireTriggers(state, { kind: 'onApplyPoison' }, actor)
}

function enemyTokensApplied(
  state: CombatState,
  actor: Player,
  target: Enemy,
  gained: number,
  context: PlayContext,
): void {
  for (let i = 0; i < gained; i++) {
    if (context.pendingEnemyTokenTriggers) {
      context.pendingEnemyTokenTriggers.push({ playerId: actor.id, enemyUid: target.uid })
    } else {
      fireTriggers(state, { kind: 'onPutEnemyToken', enemyUid: target.uid }, actor)
    }
  }
}

function enemyInGroup(enemy: Enemy, group: 'gremlin' | 'darkling'): boolean {
  return group === 'darkling'
    ? enemy.defId.startsWith('darkling')
    : ['mad_gremlin', 'sneaky_gremlin', 'gremlin_wizard', 'fat_gremlin'].includes(enemy.defId)
}

function reviveAll(state: CombatState, group: 'gremlin' | 'darkling'): number {
  let revived = 0
  for (const target of state.enemies) {
    if (!target.dead || !enemyInGroup(target, group)) continue
    target.dead = false
    target.hp = group === 'darkling' ? 4 : startingHp(enemyDef(target.defId, target.ascension), state.players.length)
    target.block = target.strength = target.vulnerable = target.weak = target.poison = 0
    target.actionIndex = 0
    target.abilityUsed = false
    revived++
  }
  return revived
}

/** Whether this enemy's death has printed work that must wait for the card to finish. */
function enemyHasDeathReaction(state: CombatState, enemy: Enemy): boolean {
  const own = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
  if (own.some((ability) =>
    ability.kind === 'splitOnDeath' || ability.kind === 'rebirth' || ability.kind === 'sporeCloud')) return true
  if (enemy.corpseExplosion) return true
  return state.enemies.some((ally) => !ally.dead && ally.row === enemy.row &&
    enemyAbilities(enemyDef(ally.defId, ally.ascension)).some((ability) =>
      ability.kind === 'furyOnAllyDeath' &&
      (ability.allyDefId === enemy.defId || enemy.defId.startsWith(`${ability.allyDefId}_`))))
}

function triggerEnemyDeath(state: CombatState, enemy: Enemy): void {
  const abilities = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
  const name = enemyLabel(state.enemies, enemy)
  const split = abilities.find((ability) => ability.kind === 'splitOnDeath')
  if (split?.kind === 'splitOnDeath' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    for (const player of state.players.filter((candidate) => !candidate.dead)) {
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: player.row, defIds: split.defIds, turn: state.turn + 1,
        strength: split.largeSlimeStrength, strengthDefId: 'large_slime',
      })
    }
    state.log = [...state.log, `${name} will Split next turn`]
  }
  const rebirth = abilities.find((ability) => ability.kind === 'rebirth')
  if (rebirth?.kind === 'rebirth' && !enemy.abilityUsed) {
    enemy.abilityUsed = true
    if (rebirth.timing) {
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: enemy.row, defIds: [rebirth.defId ?? enemy.defId],
        turn: state.turn + Number(rebirth.timing === 'startOfTurn'), timing: rebirth.timing,
        direct: true, isBoss: enemy.isBoss,
        strength: rebirth.strength, strengthPerPower: rebirth.strengthPerPower && (enemy.ascension ?? 0) >= 10,
      })
      state.log = [...state.log, `${name} will return ${rebirth.timing === 'startOfTurn' ? 'next round' : 'at the end of the turn'}`]
    } else {
      const nextDefId = rebirth.defId ?? enemy.defId
      if (nextDefId !== enemy.defId) enemy.actionIndex = 0
      enemy.defId = nextDefId
      enemy.dead = false
      enemy.hp = rebirth.hpPerPlayer * state.players.length
      enemy.maxHp = Math.max(enemy.maxHp, enemy.hp)
      enemy.block = 0
      if (rebirth.clearWeakVulnerable) enemy.weak = enemy.vulnerable = 0
      enemy.strength = gainStrength(enemy.strength, rebirth.strength ?? 0)
      state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} returns with ${enemy.hp} HP`]
    }
  }
  const spore = abilities.find((ability) => ability.kind === 'sporeCloud')
  if (spore?.kind === 'sporeCloud') {
    for (const target of playersInRowOf(state, enemy)) {
      const before = target.vulnerable
      target.vulnerable = gainVulnerable(target.vulnerable, spore.vulnerable)
      if (target.vulnerable > before) {
        state.log = [...state.log, `${name}'s Spore Cloud left ${target.name} vulnerable`]
      }
    }
  }
  for (const ally of state.enemies) {
    if (ally.dead || ally.row !== enemy.row) continue
    const fury = enemyAbilities(enemyDef(ally.defId, ally.ascension)).find((ability) =>
      ability.kind === 'furyOnAllyDeath' &&
      (ability.allyDefId === enemy.defId || enemy.defId.startsWith(`${ability.allyDefId}_`)))
    if (fury?.kind !== 'furyOnAllyDeath' || ally.abilityUsed) continue
    ally.abilityUsed = true
    ally.strength = gainStrength(ally.strength, fury.strength)
    state.log = [...state.log, `${enemyLabel(state.enemies, ally)} enters Fury`]
  }
  const attachment = enemy.corpseExplosion
  enemy.corpseExplosion = undefined
  if (attachment) {
    const owner = findPlayer(state, attachment.playerId)
    state.log = [...state.log, `Corpse Explosion detonates for ${attachment.damage} in ${name}'s row`]
    for (const target of state.enemies.filter((candidate) =>
      !candidate.dead && (enemy.isBoss || candidate.row === enemy.row || candidate.isBoss))) {
      if (target.dead) continue
      damageEnemyLogged(state, target, attachment.damage, 'Corpse Explosion')
    }
    if (owner) discardByCardEffect(state, owner, [attachment.card])
  }
}

/**
 * Damages an enemy and says so.
 *
 * The log reported every blow an enemy struck but nothing the party struck
 * back, which left the player's own damage — the number Strength, Weak and
 * Vulnerable all modify — as the one figure they had to read off an HP bar.
 */
function damageEnemyLogged(
  state: CombatState,
  enemy: Enemy,
  damage: number,
  source?: string,
): void {
  const wasAlive = !enemy.dead
  const hpBefore = enemy.hp
  const result = damageEnemy(state, enemy, damage)
  const name = enemyLabel(state.enemies, enemy)
  if (source) {
    const lost = hpBefore - enemy.hp
    const blocked = result.blocked
    state.log = [
      ...state.log,
      lost > 0
        // "damages", never "hit": a hit is specifically what Strength, Weak
        // and Vulnerable modify, and every caller here — the plain `damage`
        // effect and the orbs — is none of those. The `hit` case builds its
        // own line because it aggregates a multi-hit into one.
        ? `${source} damages ${name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : blocked > 0
          ? `${name} blocked ${source} completely (${blocked} spent)`
          : `${source} did no damage to ${name}`,
    ]
  }
  if (wasAlive && enemy.dead) {
    state.log = [...state.log, `${name} is dead`]
    triggerEnemyDeath(state, enemy)
  } else if (result.curled) {
    state.log = [...state.log, `${name}'s Curl Up gained Block`]
  }
  if (result.hpLost > 0 && !combatIsOver(state) &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'shift')) {
    grantShiftBlock(state, enemy, result.hpLost)
  }
}

function preventPlayerHpLoss(state: CombatState, player: Player, amount: number): boolean {
  if (amount <= 0) return false
  const held = player.powers.find((power) =>
    faceOf(cardDef(power.defId), power.upgraded).effects.some((effect) => effect.kind === 'preventHpLoss'))
  if (!held) return false
  const effect = faceOf(cardDef(held.defId), held.upgraded).effects
    .find((candidate) => candidate.kind === 'preventHpLoss')!
  held.counter = (held.counter ?? 0) + 1
  state.log = [...state.log, `${player.name}'s Buffer prevents ${amount} HP loss`]
  if (held.counter < effect.uses) return true
  player.powers = player.powers.filter((power) => power.uid !== held.uid)
  held.counter = undefined
  exhaustCards(state, player, [held])
  state.log = [...state.log, `${player.name} exhausts Buffer`]
  return true
}

function losePlayerHp(state: CombatState, player: Player, amount: number): number {
  const remaining = remainingRoundHpLoss(player)
  const limited = remaining === undefined
    ? amount
    : Math.min(amount, remaining)
  const losable = Math.min(player.hp, Math.max(0, limited))
  if (preventPlayerHpLoss(state, player, losable)) return 0
  const outcome = applyHpLoss(player.hp, losable)
  if (outcome.hpLost > 0) {
    player.lostHpThisCombat = true
    player.hpLostThisRound = (player.hpLostThisRound ?? 0) + outcome.hpLost
  }
  player.hp = outcome.hp
  if (player.hp === 0) {
    const fairy = player.potions.indexOf('fairy_in_a_bottle')
    if (fairy >= 0) {
      player.potions.splice(fairy, 1)
      state.potionDeck.push('fairy_in_a_bottle')
      player.hp = 2
      addPresentationEvent(state, {
        kind: 'potion',
        actorId: player.id,
        sourceId: 'fairy_in_a_bottle',
        enemyIds: [],
        playerIds: [player.id],
      })
      state.log = [...state.log, `${player.name}'s Fairy in a Bottle restores them to 2 HP`]
    } else {
      player.dead = true
    }
  }
  return outcome.hpLost
}

function damagePlayer(state: CombatState, player: Player, damage: number): { fullyBlocked: boolean; hpLost: number } {
  const outcome = applyDamage(player.block, player.hp, damage)
  player.block = outcome.block
  return { fullyBlocked: outcome.fullyBlocked, hpLost: losePlayerHp(state, player, outcome.hpLost) }
}

function timeWarpLimit(state: CombatState): number {
  const eater = state.enemies.find((enemy) => !enemy.dead &&
    enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'timeWarp'))
  const warp = eater && enemyAbilities(enemyDef(eater.defId, eater.ascension))
    .find((ability) => ability.kind === 'timeWarp')
  return warp?.kind === 'timeWarp'
    ? warp.limits[eater!.actionIndex] ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY
}

export function reachedTimeWarpLimit(state: CombatState, player: Player): boolean {
  return (player.cardsPlayedThisTurn ?? 0) >= timeWarpLimit(state)
}

/** The Energy actually charged for a card on this player's current board. */
export function playCost(
  def: CardDef,
  player: Pick<Player, 'powers' | 'relics' | 'lostHpThisCombat' | 'freeCardsThisTurn' | 'nextCardCost' | 'freeAttacksThisTurn'>,
  card?: Pick<CardInstance, 'freeThisTurn' | 'costReductionThisTurn'>,
): number | 'X' {
  if (player.nextCardCost !== null && player.nextCardCost !== undefined) return player.nextCardCost
  if (card?.freeThisTurn === true || (player.freeCardsThisTurn ?? 0) > 0 ||
    (def.type === 'attack' && (player.freeAttacksThisTurn ?? 0) > 0)
  ) return 0
  const cost = cardCost(def, player.powers, player.lostHpThisCombat)
  return cost === 'X' ? cost : Math.max(0, cost - (card?.costReductionThisTurn ?? 0))
}

/**
 * The choices a card needs, supplied with the play rather than collected through
 * a prompt. Keeping a card play atomic means the server validates one message
 * instead of holding half-resolved state between round trips.
 */
export type PlayContext = {
  /** Enemy chosen for offensive effects. */
  enemyUid: string | null
  /** A row chosen directly instead of through an enemy anchor. */
  enemyRow?: number | null
  /** Player chosen for supportive effects that may target an ally. */
  playerId: string | null
  /** Energy chosen for an X-cost card. Must meet `CardDef.minimumX`. */
  energySpent?: number
  /** One enemy per independently targeted printed token. Duplicates are legal. */
  enemyUids?: string[]
  /** One player per independently targeted printed Block icon. Duplicates are legal. */
  playerIds?: string[]
  /** Another living player whose row is optionally exchanged with the caster's. */
  switchWithPlayerId?: string | null
  /** Zero-based printed mode for a modal card face. */
  mode?: number
  /** Cards chosen to discard, for effects like Survivor. */
  discardUids?: string[]
  /** Cards chosen to exhaust from hand, for effects like True Grit. */
  exhaustUids?: string[]
  /** Cards chosen to return to the top of the draw pile. */
  topdeckUids?: string[]
  /** Card chosen to move from discard to the top of the draw pile. */
  recoverDiscardUid?: string
  /** Cards chosen to move from discard, in selection order. */
  recoverDiscardUids?: string[]
  recoverExhaustUid?: string
  /** Cards chosen from a privately revealed draw pile by Seek. */
  searchDrawUids?: string[]
  /** Spend one Miracle atomically with this card, which may take Energy above 6. */
  spendMiracle?: boolean
  /** One chosen target or explicit skip per immediate Shiv, in effect order. */
  shivEnemyUids?: (string | null)[]
  /** Of the cards a Scry revealed, the ones the player bins. */
  scryDiscardUids?: string[]
  /**
   * Which orb slot to evoke, when the player has a choice. The board game lets
   * you evoke ANY orb, unlike the video game's fixed front slot (p.16).
   */
  evokeSlots?: number[]
  /** One enemy per evoke; Frost uses null so choices stay aligned. */
  evokeEnemyUids?: (string | null)[]
  /**
   * Cards already given up by an earlier clause of the SAME card.
   *
   * Belt and braces, honestly: both consuming effects splice what they took out
   * of the hand immediately, so the membership test in `allocate` already stops
   * a second clause re-taking the same uid, and deleting this set changes no
   * outcome on any card or hostile input I could construct. It is kept for the
   * clause that resolves without removing from hand — a "reveal a card" cost,
   * say — where the hand check alone would let one card pay twice. Filled in
   * during resolution; callers never set it.
   */
  spentUids?: Set<string>
  /**
   * Set when a consuming clause could not be paid from the hand it faced.
   *
   * A card's cost is checked as each clause resolves, not before the card
   * starts, because an earlier clause can change what the hand holds.
   * Acrobatics reads "Draw 3 cards. Discard 1 card." and the card you discard
   * is very often one of the three you just drew. Filled in during resolution;
   * callers never set it.
   */
  shortfall?: boolean
  /** Internal cursor while multiple gain-Shiv clauses consume target choices. */
  shivTargetIndex?: number
  /** A queued overflow attack named an enemy killed by an earlier queued attack. */
  invalidShivTarget?: boolean
  /** Internal cursor while a card resolves its ordered evokes. */
  evokeIndex?: number
  /** Internal target cursor; one removed Orb can apply its Evoke effect repeatedly. */
  evokeTargetIndex?: number
  /** A queued evoke named an enemy killed by an earlier effect. */
  invalidEvokeTarget?: boolean
  /** A Scry named a card outside the cards it actually revealed. */
  invalidScryChoice?: boolean
  /** Discards whose reactions wait until this card finishes its printed text. */
  pendingDiscards?: { playerId: string; cards: CardInstance[] }[]
  /** Poison gains whose reactions wait until this card finishes its printed text. */
  pendingPoisonTriggers?: string[]
  /** Enemy token gains whose per-token reactions wait until this card finishes. */
  pendingEnemyTokenTriggers?: { playerId: string; enemyUid: string }[]
  /** Enemy reactions wait until all text on the current card has resolved. */
  pendingEnemyDamage?: { enemyUid: string; amount: number }[]
  pendingEnemyDeathUids?: string[]
  pendingAttackTargets?: string[]
  /** Nested reactions whose abilities wait until this card finishes. */
  pendingTriggers?: PendingTrigger[]
  /** Exhausts whose card and Power reactions wait until this card finishes its printed text. */
  pendingExhaustTriggers?: { playerId: string; card: CardInstance }[]
  /** Internal result of the immediately preceding direct draw effect. */
  drewSkill?: boolean
  /** Public source label for Orb channel animations, including triggered Powers and relics. */
  presentationSourceId?: string
  /** Cards taken by this card's variable discard clause. */
  discardedByCard?: number
  /** Cards taken by this card's automatic Exhaust clause. */
  exhaustedByCard?: number
  /** Cost of the card taken by the immediately preceding single-card Exhaust. */
  exhaustedCardCost?: number | 'X'
  /** A variable discard named a duplicate or a card outside the current hand. */
  invalidDiscardChoice?: boolean
  /** A variable exhaust exceeded its limit, repeated a card, or named a card outside the hand. */
  invalidExhaustChoice?: boolean
  /** A topdeck choice named a duplicate or a card outside the current hand. */
  invalidTopdeckChoice?: boolean
  /** A recovery choice was missing or named a card outside the discard pile. */
  invalidRecoverChoice?: boolean
  /** Seek named duplicates, the wrong count, or cards outside the draw pile. */
  invalidSearchChoice?: boolean
  /** Whether the card being played was kept by Retain last turn. */
  sourceRetainedLastTurn?: boolean
  /** Printed type of the card currently resolving, for Footwork. */
  sourceCardType?: CardType
  /** Definition id of the card currently resolving, for Apotheosis. */
  sourceCardId?: string
  /** Instance id of the physical card currently resolving. */
  sourceCardUid?: string
  /** Face of the physical card currently resolving. */
  sourceCardUpgraded?: boolean
  /** Weave's bonus while it is being played after a Scry discard. */
  sourceScryDamageBonus?: number
  /** Virtual play-twice copies cannot attach a physical card. */
  sourceIsCopy?: boolean
  /** The eligible card selected by a physical Doppelganger resolution. */
  doppelgangerCopy?: CardInstance
  /** Effect that queued `doppelgangerCopy`; the shared copy pipeline serves both cards. */
  queuedCopySource?: 'Doppelganger' | 'Foreign Influence' | 'Weave' | 'Omniscience'
  /** Whether the queued copy has no physical card to clean up. */
  queuedCopyVirtualOnly?: boolean
  /** Omniscience resolves its queued physical card twice. */
  queuedCopyTwice?: boolean
  /** Omniscience Exhausts the queued physical card after both plays. */
  queuedCopyForcedExhaust?: boolean
  /** Every pending resolution label for a card that has not started resolving yet. */
  queuedCopySourceNames?: ('Double Tap' | 'Blasphemy' | 'Echo Form' | 'Burst' | 'Doppelganger' | 'Foreign Influence' | 'Omniscience' | 'Weave')[]
  queuedCopySources?: CopySource[]
  consumeQueuedFreeCard?: boolean
  consumeQueuedFreeAttack?: boolean
  queuedWeaves?: CardInstance[]
  /** Cubes printed onto a Power as it enters play. */
  sourceCounter?: number
  /** This resolution attached its source card instead of discarding it. */
  sourceAttached?: boolean
  /** Power instance currently resolving its trigger, for counters and self-Exhaust. */
  sourcePowerUid?: string
  /** The source Attack was recorded early so its later Shiv attacks follow it. */
  sourceAttackCounted?: boolean
  /** HP removed by the immediately preceding hit effect. */
  lastHitDamage?: number
}

export type CardChoicePreview = {
  kind: 'discard' | 'scry' | 'topdeck' | 'search'
  cards: CardInstance[]
}

export type PotionContext = {
  enemyUid?: string | null
  targetPlayerId?: string | null
  enemyRow?: number | null
  shivEnemyUids?: string[]
  recoverDiscardUid?: string
  exhaustUids?: string[]
  /** Gambler's Brew replacement for the shared die. */
  die?: number
  /** Held Potion discarded when Entropic Brew would exceed the slot limit. */
  replacePotionId?: string
}

function invalidPlayChoice(context: PlayContext): boolean {
  return Boolean(context.shortfall || context.invalidShivTarget || context.invalidEvokeTarget ||
    context.invalidScryChoice || context.invalidDiscardChoice || context.invalidExhaustChoice ||
    context.invalidTopdeckChoice || context.invalidRecoverChoice || context.invalidSearchChoice)
}

function releasePendingTriggers(state: CombatState, context: PlayContext): void {
  if (context.pendingTriggers?.length) {
    state.pendingTriggers = [...(state.pendingTriggers ?? []), ...context.pendingTriggers]
  }
  flushPendingTriggers(state)
}

function resolutionContext(
  context: PlayContext,
  def: CardDef,
  held: CardInstance,
  energySpent: number,
  sourceIsCopy = false,
): PlayContext {
  return {
    ...context,
    enemyUids: context.enemyUids ? [...context.enemyUids] : undefined,
    playerIds: context.playerIds ? [...context.playerIds] : undefined,
    topdeckUids: context.topdeckUids ? [...context.topdeckUids] : undefined,
    recoverDiscardUids: context.recoverDiscardUids ? [...context.recoverDiscardUids] : undefined,
    searchDrawUids: context.searchDrawUids ? [...context.searchDrawUids] : undefined,
    shivEnemyUids: context.shivEnemyUids ? [...context.shivEnemyUids] : undefined,
    evokeSlots: context.evokeSlots ? [...context.evokeSlots] : undefined,
    evokeEnemyUids: context.evokeEnemyUids ? [...context.evokeEnemyUids] : undefined,
    spentUids: new Set<string>(),
    shortfall: false,
    shivTargetIndex: 0,
    invalidShivTarget: false,
    evokeIndex: 0,
    evokeTargetIndex: 0,
    invalidEvokeTarget: false,
    invalidScryChoice: false,
    invalidDiscardChoice: false,
    invalidExhaustChoice: false,
    invalidTopdeckChoice: false,
    invalidRecoverChoice: false,
    invalidSearchChoice: false,
    discardedByCard: 0,
    exhaustedByCard: 0,
    exhaustedCardCost: undefined,
    pendingDiscards: [],
    pendingPoisonTriggers: [],
    pendingEnemyTokenTriggers: [],
    pendingEnemyDamage: [],
    pendingEnemyDeathUids: [],
    pendingAttackTargets: [],
    pendingTriggers: [],
    pendingExhaustTriggers: [],
    drewSkill: false,
    presentationSourceId: def.id,
    sourceRetainedLastTurn: held.retainedLastTurn === true,
    sourceCardType: def.type,
    sourceCardId: def.id,
    sourceCardUid: held.uid,
    sourceCardUpgraded: held.upgraded,
    sourceScryDamageBonus: held.scryDamageBonus,
    sourceIsCopy,
    doppelgangerCopy: undefined,
    queuedCopySource: undefined,
    queuedCopyVirtualOnly: undefined,
    queuedCopyTwice: undefined,
    queuedCopyForcedExhaust: undefined,
    queuedCopySourceNames: undefined,
    sourceCounter: undefined,
    sourceAttached: false,
    energySpent,
    sourceAttackCounted: false,
    lastHitDamage: 0,
  }
}

export function overflowShivCount(state: { players: readonly { shivs: number }[] }, amount: number): number {
  const held = state.players.reduce((sum, player) => sum + player.shivs, 0)
  return Math.max(0, amount - Math.max(0, CAPS.shivs - held))
}

/**
 * Whether a conditional clause's condition holds right now.
 *
 * "Right now" is load-bearing: this is read as the clause resolves, not when
 * the card is played, so an earlier clause of the same card can change the
 * answer. No printed card does that yet — every condition here reads something
 * its own card leaves alone — but resolving them all up front would be a
 * decision, not a simplification, and the wrong one: the table reads a card
 * top to bottom.
 */
function holds(
  condition: Condition,
  state: CombatState,
  actor: Player,
  /** The enemy this clause is landing on, for conditions that read the target. */
  target?: Enemy,
): boolean {
  switch (condition.kind) {
    case 'hasShiv':
      return actor.shivs > 0
    case 'targetPoisoned':
      return (target?.poison ?? 0) > 0
    case 'discardTopCosts': {
      // The topmost card is the one most recently discarded, which is the end
      // of the array — the pile is stored bottom-first.
      const top = actor.discard.at(-1)
      if (!top) return false
      // The UPGRADED face's cost, when that is the face in the pile: upgrading
      // a card to 0 is the ordinary way a player turns Steam Barrier on.
      const face = faceOf(cardDef(top.defId), top.upgraded)
      // An unplayable card has NO cost -- p.24, and the scans print no energy
      // gem at all on one. `CARDS.daze` stores 0 because the field is not
      // optional, and that placeholder made a Daze read as a 0-cost card and
      // pay out Steam Barrier's bonus. Reachable in ordinary play: an enemy
      // deals a Daze, it cannot be played, and it is left on top of the discard
      // by the end-of-turn sweep precisely because everything else WAS played.
      if (face.unplayable) return false
      return cardCost(face, actor.powers, actor.lostHpThisCombat) === condition.cost
    }
    case 'dieShows':
      return condition.faces.includes(state.die)
    case 'inStance':
      return actor.stance === condition.stance
    case 'notInStance':
      return actor.stance !== condition.stance
    case 'discardedThisTurn':
      return state.discardedThisTurn.includes(actor.id)
    case 'stanceChangedThisTurn':
      return state.stanceChangedThisTurn.includes(actor.id)
    case 'targetFullHp':
      return target?.hp === target?.maxHp
    case 'firstTurnOfCombat':
      return state.turn === 1
    case 'firstCardPlayedThisTurn':
      return (actor.cardsPlayedThisTurn ?? 0) === 1
    case 'hasNoAttacksInHand':
      return actor.hand.every((card) => cardDef(card.defId).type !== 'attack')
    case 'allCardsInHandAreAttacks':
      return actor.hand.every((card) => cardDef(card.defId).type === 'attack')
    case 'onlyAttackInHand':
      return actor.hand.filter((card) => cardDef(card.defId).type === 'attack').length === 1
    case 'goldAtLeast':
      return actor.gold >= condition.amount
    case 'orbsAtLeast':
      return actor.orbs.filter((orb) => orb !== null).length >= condition.amount
    case 'drawPileEmpty':
      return actor.draw.length === 0
    case 'handEmpty':
      return actor.hand.length === 0
    case 'drewSkill':
    case 'retainedLastTurn':
      return false
  }
}

function conditionIsActive(
  condition: Condition,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn'>,
  target?: Enemy,
): boolean {
  if (condition.kind === 'drewSkill') return context?.drewSkill === true
  if (condition.kind === 'retainedLastTurn') return context?.sourceRetainedLastTurn === true
  return holds(condition, state, actor, target)
}

/** Whether a conditional printed clause applies to the current board. */
export function effectIsActive(
  effect: Effect,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn'>,
): boolean {
  return !effect.when || conditionIsActive(effect.when, state, actor, context)
}

/** Whether the card's printed play restriction currently allows it. */
export function cardPlayConditionMet(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
  sourceInHand = true,
): boolean {
  // Online snapshots hide draw identities but publish their count.
  if (def.playCondition?.kind === 'drawPileEmpty') return drawCount === 0
  if (def.playCondition?.kind === 'onlyAttackInHand') {
    const attacks = actor.hand.filter((card) => cardDef(card.defId).type === 'attack').length
    return attacks === (sourceInHand ? 1 : 0)
  }
  return !def.playCondition || holds(def.playCondition, state, actor)
}

/** Whether a card can resolve at all before Energy and player choices are considered. */
export function cardIsPlayable(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
  sourceInHand = true,
): boolean {
  return actor.cardPlayLocked !== true && !def.unplayable &&
    cardPlayConditionMet(def, state, actor, drawCount, sourceInHand)
}

type CountablePlayer = Pick<Player, 'id' | 'row' | 'orbs' | 'block' | 'strength' | 'miracles' | 'stance' |
  'attacksPlayedThisTurn' | 'exhaust' | 'clawCubesGainedThisCombat'> & {
  hand: readonly CardInstance[] | null
}

/** What a card counts off the board. */
function countOf(count: CountOf, actor: CountablePlayer, state?: CombatState, energySpent = 0): number {
  switch (count) {
    case 'orbs':
      return actor.orbs.filter((orb) => orb !== null).length
    case 'frostOrbs':
      return actor.orbs.filter((orb) => orb === 'frost').length
    case 'lightningOrbs':
      return actor.orbs.filter((orb) => orb === 'lightning').length
    case 'orbTypes':
      return new Set(actor.orbs.filter((orb) => orb !== null)).size
    case 'block':
      return actor.block
    case 'strength':
      return actor.strength
    case 'miracles':
      return actor.miracles
    case 'cardsInHand':
      return actor.hand?.length ?? 0
    case 'retainCardsInHand':
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).retain).length ?? 0
    case 'cardsInExhaust':
      return actor.exhaust.length
    case 'energySpent':
      return energySpent
    case 'strikesInHand':
      return actor.hand?.filter((card) => cardDef(card.defId).name.includes('Strike')).length ?? 0
    case 'skillsInHand':
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'skill').length ?? 0
    case 'attacksInHand':
      return actor.hand?.filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'attack').length ?? 0
    case 'attacksPlayedThisTurn':
      return actor.attacksPlayedThisTurn ?? 0
    case 'attackingEnemies':
      if (!state) return 0
      return state.enemies.filter((enemy) => !enemy.dead && actionsFor(
        enemyDef(enemy.defId, enemy.ascension), state.die, enemy.actionIndex,
      ).some((action) => action.kind === 'attack' && (action.aoe || enemy.isBoss || enemy.row === actor.row))).length
    case 'clawCubesGainedThisCombat':
      return actor.clawCubesGainedThisCombat ?? 0
  }
}

/** The number a clause actually uses, once the board has been read. */
function amountOf(
  amount: Amount,
  state: CombatState,
  actor: Player,
  target?: Enemy,
  context?: PlayContext,
): number {
  if (typeof amount === 'number') return amount
  let total = amount.base
  if (amount.bonus && conditionIsActive(amount.bonus.when, state, actor, context, target)) {
    total += amount.bonus.plus
  }
  if (amount.per) total += countOf(amount.per, actor, state, context?.energySpent) * (amount.scale ?? 1)
  if (target && amount.targetTokens) {
    for (const token of amount.targetTokens) total += target[token]
  }
  return total
}

function latestAllyAttack(state: CombatState, playerId: string) {
  return [...(state.playedCardsThisTurn ?? [])].reverse().find((played) =>
    played.playerId !== playerId && !played.copied &&
    faceOf(cardDef(played.card.defId), played.card.upgraded).type === 'attack')
}

function latestPlayableAllyAttack(
  state: CombatState,
  actor: Player,
  sourceCardUid?: string,
  drawCount = actor.draw.length,
) {
  const latest = latestAllyAttack(state, actor.id)
  if (!latest) return undefined
  const def = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
  const checkingActor = sourceCardUid
    ? { ...actor, hand: actor.hand.filter((card) => card.uid !== sourceCardUid) }
    : actor
  return (def.minimumX ?? 0) === 0 && cardIsPlayable(
    def, state, checkingActor, drawCount, false,
  )
    ? latest
    : undefined
}

function omniscienceEligibleCards(state: CombatState, actor: Player): CardInstance[] {
  return actor.draw.filter((card) => {
    const def = faceOf(cardDef(card.defId), card.upgraded)
    return (def.type === 'attack' || def.type === 'skill') &&
      (def.minimumX ?? 0) === 0 && cardIsPlayable(def, state, actor, actor.draw.length - 1, false)
  })
}

function copySourcesFor(def: CardDef, actor: Player): CopySource[] {
  return def.id === 'burst' ? []
    : (def.type === 'attack' || def.type === 'skill') && (actor.doubledCardsThisTurn ?? 0) > 0
      ? ['Echo Form']
      : def.type === 'attack' && (actor.tripledAttacksThisTurn ?? 0) > 0
        ? ['Blasphemy', 'Blasphemy']
        : def.type === 'attack' && (actor.doubledAttacksThisTurn ?? 0) > 0
          ? ['Double Tap']
          : def.type === 'skill' && (actor.doubledSkillsThisTurn ?? 0) > 0
            ? ['Burst']
            : []
}

function consumeCopySource(actor: Player, sources: readonly CopySource[]): void {
  if (sources.includes('Echo Form')) actor.doubledCardsThisTurn = actor.doubledCardsThisTurn! - 1
  else if (sources.includes('Blasphemy')) actor.tripledAttacksThisTurn = actor.tripledAttacksThisTurn! - 1
  else if (sources.includes('Double Tap')) actor.doubledAttacksThisTurn = actor.doubledAttacksThisTurn! - 1
  else if (sources.includes('Burst')) actor.doubledSkillsThisTurn = actor.doubledSkillsThisTurn! - 1
}

/**
 * Applies one effect. Mutates the draft state, which is always a clone owned by
 * the caller — never the state handed in from outside.
 */
function applyEffect(
  state: CombatState,
  actor: Player,
  effect: Effect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  /** The Power or relic that caused this, when it was not a card being played. */
  source?: string,
  /** Keep the attacker's Weak until a parent multi-target clause finishes. */
  deferWeakSpend = false,
  /** Keep each target's Vulnerable until a parent multi-target clause finishes. */
  deferVulnerableSpend = false,
): void {
  const mods = attackerModsOfPlayer(actor)
  /** Who the log should credit: the ongoing effect if there is one, else the player. */
  const who = source ?? actor.name
  /**
   * Reports a change to the party's own state.
   *
   * The enemies' equivalents were all logged and the players' were not, which
   * made the log read as a record of what was done TO you rather than of the
   * round. A Power or relic names itself, so a recurring effect can be told
   * apart from a card that was just played.
   */
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }
  const noteAt = (at: number, text: string) => {
    const line = source ? `${source}: ${text}` : text
    state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
  }

  // A whole clause that the board can switch off, as the Weak on Go for the
  // Eyes is. Checked before the target scope is resolved, because a clause that
  // does not happen does not pick a target either.
  //
  // Conditions that read a TARGET are not usable here — there is no one target
  // yet — and the only one of those, `targetPoisoned`, is a damage bonus that
  // belongs inside an `Amount`. `verify-architecture.mjs` holds that line.
  if (!effectIsActive(effect, state, actor, context)) return

  switch (effect.kind) {
    case 'hit': {
      const targets = resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)
      // Barrage deals one hit per Orb, so the swing count is read off the board
      // once, before the first target — not per target, which would let an
      // area-of-effect card re-count between enemies.
      const times = effect.times === undefined ? 1 : amountOf(effect.times, state, actor, undefined, context)
      // A counted attack can come to nothing — Barrage held with no Orbs. It is
      // a legal play and still costs the Energy, but it lands no hits, and both
      // Weak and Vulnerable are spent by a hit LANDING (p.24). Paying them out
      // anyway laundered the attacker's own Weak off for 1 Energy. Such a card
      // also asks for no target, so `targets` is empty and the loop below would
      // leave the log silent about a card the player just spent.
      if (times === 0) {
        // `note` prefixes the source itself, so this names the player, not
        // `who` -- which already carries the source and would print it twice.
        note(`${actor.name} had nothing to attack with`)
        return
      }
      for (const target of targets) {
        if (context.sourceCardType === 'attack') context.pendingAttackTargets?.push(target.uid)
        // Every hit of a multi-hit is modified, but only ONE token comes off
        // after the whole thing resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        const hpBefore = target.hp
        const wasAlive = !target.dead
        // Bane's bonus reads the enemy being struck, so the printed number is
        // worked out per target rather than once for the card.
        const sourceFace = context.sourceCardId
          ? faceOf(cardDef(context.sourceCardId), context.sourceCardUpgraded ?? false)
          : undefined
        const wristBlade = actor.relics.some((relic) => relic.defId === 'wrist_blade') &&
          (source === 'Shiv' || (sourceFace && cardCost(sourceFace, actor.powers, actor.lostHpThisCombat) === 0)) ? 1 : 0
        const each = actor.damageDealtZeroThisTurn ? 0 : amountOf(effect.amount, state, actor, target, context) + wristBlade +
          (context.sourceScryDamageBonus ?? 0) +
          (context.sourceCardId?.startsWith('strike_') ? (actor.starterStrikeDamageBonus ?? 0) : 0)
        let blocked = 0
        let curled = false
        let poisonAppliedTotal = 0
        let poisonEvents = 0
        let damagingHits = 0
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          const abilities = enemyAbilities(enemyDef(target.defId, target.ascension))
          const slow = abilities.find((ability) => ability.kind === 'slow')
          const flying = abilities.find((ability) => ability.kind === 'flying')
          let amount = each + (slow?.kind === 'slow' ? slow.damagePerHit : 0)
          amount = hitDamage(amount, mods, { vulnerable: vulnerableAtStart })
          if (actor.damageDealtZeroThisTurn) amount = 0
          if (flying?.kind === 'flying') amount = Math.min(amount, flying.maxDamagePerHit)
          const result = damageEnemy(state, target, amount, context.sourceCardType !== undefined)
          blocked += result.blocked
          curled = result.curled || curled
          if (result.hpLost > 0) {
            damagingHits++
            context.pendingEnemyDamage?.push({ enemyUid: target.uid, amount: result.hpLost })
          }
          if (!target.dead && actor.hitPoison > 0) {
            const gained = putPoison(state, target, actor.hitPoison)
            poisonAppliedTotal += gained
            if (gained > 0) poisonEvents += 1
          }
        }
        if (!deferVulnerableSpend && vulnerableAtStart > 0) target.vulnerable = vulnerableAtStart - 1
        // One line for the whole attack, not one per swing: a five-hit card
        // would otherwise bury the round in near-identical lines.
        const name = enemyLabel(state.enemies, target)
        const lost = hpBefore - target.hp
        context.lastHitDamage = lost
        state.log = [
          ...state.log,
          lost > 0
            ? `${who} hit ${name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
            : blocked > 0
              ? `${name} blocked ${who} completely (${blocked} spent)`
              : `${who} did no damage to ${name}`,
        ]
        if (poisonAppliedTotal > 0) {
          state.log = [...state.log, `${actor.name}'s Envenom applies ${poisonAppliedTotal} Poison to ${name}`]
          for (let i = 0; i < poisonEvents; i++) poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, poisonAppliedTotal, context)
        }
        if (wasAlive && target.dead) {
          state.log = [...state.log, `${name} is dead`]
          if (context.sourceCardType !== undefined && enemyHasDeathReaction(state, target)) {
            context.pendingEnemyDeathUids?.push(target.uid)
          }
          else triggerEnemyDeath(state, target)
        } else if (curled) {
          state.log = [...state.log, `${name}'s Curl Up gained Block`]
        }
        if (context.sourceCardType === undefined) triggerAngry(state, target, damagingHits)
        if (combatIsOver(state)) break
      }
      // The attacker's own Weak is spent by attacking, exactly as an enemy's is
      // (p.24). One token per attack, however many targets or hits it had.
      if (!deferWeakSpend && targets.length > 0 && actor.weak > 0) {
        actor.weak -= 1
        // Logged because it is usually the reason the attack underperformed.
        note(`${actor.name} spends a Weak`)
      }
      return
    }
    case 'hitChoices': {
      const weakAtStart = actor.weak
      const vulnerableAtStart = new Map<string, number>()
      for (const enemyUid of context.enemyUids ?? []) {
        const target = state.enemies.find((enemy) => enemy.uid === enemyUid && !enemy.dead)
        if (!target) continue
        if (!vulnerableAtStart.has(enemyUid)) vulnerableAtStart.set(enemyUid, target.vulnerable)
        applyEffect(state, actor, { kind: 'hit', amount: effect.amount }, 'enemy', 'self', {
          ...context,
          enemyUid,
        }, source, true, true)
        if (combatIsOver(state)) break
      }
      for (const [enemyUid, vulnerable] of vulnerableAtStart) {
        if (vulnerable <= 0) continue
        const target = state.enemies.find((enemy) => enemy.uid === enemyUid)
        if (target) target.vulnerable = vulnerable - 1
      }
      if (weakAtStart > 0 && actor.weak === weakAtStart && (context.enemyUids?.length ?? 0) > 0) {
        actor.weak -= 1
        note(`${actor.name} spends a Weak`)
      }
      return
    }
    case 'damage': {
      // Not a hit: blockable, but unmodified by Strength/Weak/Vulnerable.
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : amountOf(effect.amount, state, actor, target, context), who)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'damagePerAttackIntent': {
      for (const target of state.enemies) {
        if (target.dead) continue
        const icons = actionsForEnemy(target, state.die).reduce((total, action) => {
          if (action.kind === 'attack') {
            return total + (action.aoe || target.isBoss || target.row === actor.row ? action.times ?? 1 : 0)
          }
          if (action.kind === 'attackSequence') {
            return total + action.hits.filter((hit) => hit.aoe || target.isBoss || target.row === actor.row).length
          }
          return total
        }, 0)
        if (icons > 0) damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : effect.amount * icons, who)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'loseHp': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const name = enemyLabel(state.enemies, target)
        const wasAlive = !target.dead
        const outcome = loseEnemyHp(state, target, effect.amount)
        // What was actually lost, not what was printed: an enemy on 2 hit
        // points struck for 5 loses 2.
        state.log = [...state.log, `${name} loses ${outcome.hpLost}`]
        target.hp = outcome.hp
        if (target.hp === 0) {
          target.dead = true
          // Every other kill in the game announces itself; this one used to
          // write `dead` inline and skip the line.
          if (wasAlive) state.log = [...state.log, `${name} is dead`]
          if (wasAlive) triggerEnemyDeath(state, target)
        }
        if (combatIsOver(state)) return
      }
      return
    }
    case 'loseOwnHp': {
      const lost = losePlayerHp(state, actor, effect.amount)
      if (lost > 0) note(`${actor.name} loses ${lost} HP`)
      return
    }
    case 'block': {
      // Deflect and Steam Barrier both read the CASTER's board, not the ally
      // they may be handing the Block to, so this is worked out once.
      const printedCard = context.sourceCardType === 'attack' || context.sourceCardType === 'skill'
      const base = amountOf(effect.amount, state, actor, undefined, context)
      const bonusIcon = typeof effect.amount !== 'number'
        && effect.amount.bonus
        && conditionIsActive(effect.amount.bonus.when, state, actor, context)
      const icons = 1 + Number(Boolean(bonusIcon))
      const amount = base + (printedCard ? icons * actor.cardBlockBonus : 0) +
        (context.sourceCardId?.startsWith('defend_') ? (actor.starterDefendBlockBonus ?? 0) : 0)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.block
        grantBlock(state, target, amount, context.sourceCardId ? context.pendingTriggers : undefined)
        if (target.block > before) note(`${target.name} gains ${target.block - before} Block`)
      }
      return
    }
    case 'blockChoices': {
      for (const playerId of context.playerIds ?? []) {
        applyEffect(state, actor, { kind: 'block', amount: effect.amount, toChosen: true },
          scope, 'anyPlayer', { ...context, playerId }, source)
      }
      return
    }
    case 'applyVulnerable': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const invincible = enemyAbilities(enemyDef(target.defId, target.ascension))
          .some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible) continue
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, effect.amount)
        // Only when the token actually went on: at the cap nothing happened,
        // and saying otherwise tells the player a card did something it did not.
        if (target.vulnerable > before) note(`${enemyLabel(state.enemies, target)} is vulnerable`)
        enemyTokensApplied(state, actor, target, target.vulnerable - before, context)
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const invincible = enemyAbilities(enemyDef(target.defId, target.ascension))
          .some((ability) => ability.kind === 'invincible') && !target.abilityUsed
        if (invincible) continue
        const before = target.weak
        target.weak = gainWeak(target.weak, amountOf(effect.amount, state, actor, target, context))
        if (target.weak > before) note(`${enemyLabel(state.enemies, target)} is weakened`)
        enemyTokensApplied(state, actor, target, target.weak - before, context)
      }
      return
    }
    case 'gainStrength': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.strength
        target.strength = gainStrength(target.strength, effect.amount)
        if (target.strength > before) {
          note(`${target.name} gains ${target.strength - before} Strength`)
        }
      }
      return
    }
    case 'doubleStrength': {
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, actor.strength)
      if (actor.strength > before) note(`${actor.name} gains ${actor.strength - before} Strength`)
      return
    }
    case 'gainTemporaryStrength': {
      const amount = amountOf(effect.amount, state, actor, undefined, context)
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, amount)
      const gained = actor.strength - before
      actor.strengthLossAtEndOfTurn = (actor.strengthLossAtEndOfTurn ?? 0) +
        (effect.loseGainedOnly ? gained : amount)
      if (gained > 0) note(`${actor.name} gains ${gained} Strength`)
      return
    }
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const gained = putPoison(state, target, amountOf(effect.amount, state, actor, target, context))
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
          poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, gained, context)
        }
      }
      return
    }
    case 'poisonChoices': {
      for (const enemyUid of context.enemyUids ?? []) {
        applyEffect(state, actor, { kind: 'poison', amount: effect.amount }, 'enemy', 'self', {
          ...context,
          enemyUid,
        }, source)
      }
      return
    }
    case 'multiplyPoison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const before = target.poison
        const added = before * Math.max(0, effect.factor - 1)
        const gained = putPoison(state, target, added)
        if (gained > 0) {
          note(`${enemyLabel(state.enemies, target)} takes ${gained} Poison`)
          poisonApplied(state, actor, context)
          enemyTokensApplied(state, actor, target, gained, context)
        }
      }
      return
    }
    case 'attachCorpseExplosion': {
      if (context.sourceIsCopy) return
      const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0]
      // FAQ: playing Corpse Explosion twice adds Poison twice, but its death
      // effect happens only once. The later physical card discards normally.
      if (!target || target.corpseExplosion || !context.sourceCardUid) return
      target.corpseExplosion = {
        card: {
          uid: context.sourceCardUid,
          defId: context.sourceCardId!,
          upgraded: context.sourceCardUpgraded === true,
        },
        playerId: actor.id,
        damage: effect.damage,
      }
      context.sourceAttached = true
      note(`${actor.name} attaches Corpse Explosion to ${enemyLabel(state.enemies, target)}`)
      return
    }
    case 'copyLastPlayed': {
      if (context.sourceIsCopy) return
      const plays = state.playedCardsThisTurn ?? []
      const latest = [...plays].reverse().find((played, reverseIndex) => {
        if (played.copied || (reverseIndex === 0 && played.card.uid === context.sourceCardUid)) return false
        const def = faceOf(cardDef(played.card.defId), played.card.upgraded)
        return cardCost(def, actor.powers, actor.lostHpThisCombat) === context.energySpent &&
          (def.type === 'attack' || def.type === 'skill')
      })
      if (!latest || !context.sourceCardUid) return
      const copiedDef = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
      if (copiedDef.id === 'burst') {
        note(`${actor.name}'s Doppelganger cannot copy Burst`)
        return
      }
      if (!cardIsPlayable(copiedDef, state, actor, actor.draw.length, false) ||
        context.energySpent! < (copiedDef.minimumX ?? 0)) {
        note(`${actor.name}'s Doppelganger cannot play ${copiedDef.name}`)
        return
      }
      context.doppelgangerCopy = { ...latest.card, uid: `${context.sourceCardUid}:copy` }
      context.queuedCopySource = 'Doppelganger'
      note(`${actor.name}'s Doppelganger copies ${copiedDef.name}`)
      return
    }
    case 'copyLastAllyAttack': {
      if (context.sourceIsCopy) return
      const latest = latestPlayableAllyAttack(state, actor)
      if (!latest || !context.sourceCardUid) return
      const copiedDef = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
      context.doppelgangerCopy = { ...latest.card, uid: `${context.sourceCardUid}:copy` }
      context.queuedCopySource = 'Foreign Influence'
      note(`${actor.name}'s Foreign Influence copies ${copiedDef.name}`)
      return
    }
    case 'draw': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        // Reserve the line before drawing: a draw can reshuffle and fire
        // triggers that log, and those belong under this line, not above it.
        const at = state.log.length
        const drawnCards = drawInto(
          state,
          target,
          amountOf(effect.amount, state, actor, undefined, context),
          context.pendingTriggers,
        )
        if (target.id === actor.id) {
          context.drewSkill = drawnCards.some((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'skill')
        }
        const drawn = drawnCards.length
        if (drawn > 0) {
          const line = source ? `${source}: ${target.name} draws ${drawn}` : `${target.name} draws ${drawn}`
          state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
        }
      }
      return
    }
    case 'drawThenDiscard': {
      applyEffect(state, actor, { kind: 'draw', amount: effect.amount }, scope, supportScope, context, source)
      if (actor.hand.length > 0) {
        state.startTurnProgress = {
          choices: [],
          discard: {
            playerId: actor.id,
            sourceId: context.sourcePowerUid ? `power:${context.sourcePowerUid}` : '',
            pendingTriggers: [],
          },
        }
      }
      return
    }
    case 'drawToHandSize':
      return applyEffect(state, actor, {
        kind: 'draw', amount: Math.max(0, effect.size - actor.hand.length),
      }, scope, supportScope, context, source)
    case 'cycleHand': {
      const moved = [...actor.hand]
      discardByCardEffect(state, actor, moved, context)
      return applyEffect(state, actor, { kind: 'draw', amount: moved.length },
        scope, supportScope, context, source)
    }
    case 'discardNonRetain': {
      const moved = actor.hand.filter((card) =>
        !card.retainThisTurn && !faceOf(cardDef(card.defId), card.upgraded).retain)
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'preventDraw': {
      actor.drawLocked = true
      note(`${actor.name} cannot draw more cards this turn`)
      return
    }
    case 'preventCardPlay': {
      actor.cardPlayLocked = true
      note(`${actor.name} cannot play additional cards this turn`)
      return
    }
    case 'discountNextCard': {
      actor.freeCardsThisTurn = (actor.freeCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next card costs 0 this turn`)
      return
    }
    case 'discountNextAttack': {
      actor.freeAttacksThisTurn = (actor.freeAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack costs 0 this turn`)
      return
    }
    case 'discountHand': {
      actor.hand = actor.hand.map((card) => ({ ...card, freeThisTurn: true }))
      note(`${actor.name}'s cards in hand cost 0 this turn`)
      return
    }
    case 'discountRetainedCards': {
      actor.hand = actor.hand.map((card) => card.retainedLastTurn
        ? { ...card, costReductionThisTurn: (card.costReductionThisTurn ?? 0) + effect.amount }
        : card)
      note(`${actor.name}'s Retained cards cost ${effect.amount} less this turn`)
      return
    }
    case 'doubleNextAttack': {
      actor.doubledAttacksThisTurn = (actor.doubledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played twice`)
      return
    }
    case 'tripleNextAttack': {
      actor.tripledAttacksThisTurn = (actor.tripledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played three times`)
      return
    }
    case 'doubleNextAttackOrSkill': {
      actor.doubledCardsThisTurn = (actor.doubledCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack or Skill will be played twice`)
      return
    }
    case 'doubleNextSkill': {
      actor.doubledSkillsThisTurn = (actor.doubledSkillsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Skill will be played twice`)
      return
    }
    case 'retainAtEndOfTurn': {
      actor.retainCardsThisTurn = (actor.retainCardsThisTurn ?? 0) + effect.amount
      note(`${actor.name} may Retain ${effect.amount} card${effect.amount === 1 ? '' : 's'} this turn`)
      return
    }
    case 'limitRoundHpLoss': {
      actor.hpLossLimitThisRound = Math.min(actor.hpLossLimitThisRound ?? effect.amount, effect.amount)
      note(`${actor.name} cannot lose more than ${effect.amount} HP this round`)
      return
    }
    case 'preventHpLoss':
      // Buffer reacts in the shared HP-loss boundary, not when the Power is played.
      return
    case 'upgradeStarterCards': {
      actor.starterStrikeDamageBonus = (actor.starterStrikeDamageBonus ?? 0) + effect.amount
      actor.starterDefendBlockBonus = (actor.starterDefendBlockBonus ?? 0) + effect.amount
      note(`${actor.name}'s starter Strikes and Defends get +${effect.amount}`)
      return
    }
    case 'empowerStarterStrikes': {
      const cubes = amountOf(effect.amount, state, actor, undefined, context)
      actor.starterStrikeDamageBonus = (actor.starterStrikeDamageBonus ?? 0) + cubes
      context.sourceCounter = cubes
      note(`${actor.name} puts ${cubes} cubes on Conjure Blade; starter Strikes deal +${cubes} damage`)
      return
    }
    case 'countdownDamage': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) return
      applyEffect(state, actor, { kind: 'damage', amount: effect.damage }, 'allEnemies', 'self', context, source)
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts The Bomb`)
      return
    }
    case 'countdownExhaust': {
      const held = actor.powers.find((card) => card.uid === context.sourcePowerUid)
      if (!held) return
      held.counter = (held.counter ?? 0) + 1
      note(`${actor.name} places cube ${held.counter} of ${effect.cubes}`)
      if (held.counter < effect.cubes) return
      actor.powers = actor.powers.filter((card) => card.uid !== held.uid)
      held.counter = undefined
      exhaustCards(state, actor, [held])
      note(`${actor.name} exhausts ${cardDef(held.defId).name}`)
      return
    }
    case 'switchRows': {
      if (context.switchWithPlayerId === null || context.switchWithPlayerId === undefined) return
      const other = findPlayer(state, context.switchWithPlayerId)
      if (!other || other.dead || other.id === actor.id) return
      const row = actor.row
      actor.row = other.row
      other.row = row
      note(`${actor.name} switches rows with ${other.name}`)
      return
    }
    case 'gainEnergy': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.energy
        target.energy = Math.min(CAPS.energy, target.energy + effect.amount)
        if (target.energy > before) note(`${target.name} gains ${target.energy - before} Energy`)
      }
      return
    }
    case 'gainEnergyPerDiscard': {
      const amount = (context.discardedByCard ?? 0) + effect.bonus
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + amount)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainShiv': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.shivs - state.players.reduce((sum, player) => sum + player.shivs, 0))
        const gained = Math.min(available, effect.amount)
        target.shivs += gained
        if (gained > 0) note(`${target.name} gains ${gained} Shiv`)
        // The five cubes are a shared supply. A Shiv that cannot be taken may
        // be thrown immediately instead, using the card's chosen enemy (p.17).
        for (let i = gained; i < effect.amount; i++) {
          const at = context.shivTargetIndex ?? 0
          const enemyUid = context.shivEnemyUids?.[at]
          context.shivTargetIndex = at + 1
          if (!enemyUid) continue
          if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
            context.invalidShivTarget = true
            continue
          }
          applyEffect(
            state,
            target,
            { kind: 'hit', amount: 1 + target.shivDamageBonus },
            'enemy',
            'self',
            { ...context, enemyUid },
            'Shiv',
          )
          target.attacksPlayedThisTurn = (target.attacksPlayedThisTurn ?? 0) + 1
          if (combatIsOver(state)) return
        }
      }
      return
    }
    case 'gainShivPerDiscard':
      return applyEffect(state, actor, {
        kind: 'gainShiv', amount: (context.discardedByCard ?? 0) + effect.bonus,
      }, scope, supportScope, context, source)
    case 'useAllShivs': {
      const count = actor.shivs
      actor.shivs = 0
      if (context.sourceCardType === 'attack' && !context.sourceAttackCounted) {
        actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
        context.sourceAttackCounted = true
      }
      if (count > 0) note(`${actor.name} uses ${count} Shiv${count === 1 ? '' : 's'}`)
      for (let i = 0; i < count; i++) {
        const at = context.shivTargetIndex ?? 0
        const enemyUid = context.shivEnemyUids?.[at]
        context.shivTargetIndex = at + 1
        if (!enemyUid || resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) {
          context.invalidShivTarget = true
          continue
        }
        applyEffect(
          state,
          actor,
          { kind: 'hit', amount: 1 + actor.shivDamageBonus + effect.bonus },
          'enemy',
          'self',
          { ...context, enemyUid },
          'Shiv',
        )
        actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
        if (combatIsOver(state)) break
      }
      return
    }
    case 'gainMiracle': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const available = Math.max(0, CAPS.miracles - state.players.reduce((sum, player) => sum + player.miracles, 0))
        const amount = amountOf(effect.amount, state, actor, undefined, context)
        const before = target.miracles
        target.miracles += Math.min(available, amount)
        if (target.miracles > before) note(`${target.name} gains ${target.miracles - before} Miracle`)
      }
      return
    }
    case 'enterStance': {
      // Always the caster. Vigilance reads "2 Block to any player. Enter Calm."
      // — the target clause belongs to the Block, and no printed card puts an
      // ally into a stance (only the Prismatic Shard can, per docs/rules.md).
      if (actor.stance === effect.stance) return
      note(`${actor.name} enters ${effect.stance}`)
      // Leaving Calm grants 2 energy.
      if (actor.stance === 'calm') {
        const before = actor.energy
        actor.energy = Math.min(CAPS.energy, actor.energy + 2)
        // Leaving Calm pays 2 Energy. Unlogged, a card that cost 2 looked free.
        if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy from Calm`)
      }
      actor.stance = effect.stance
      if (!state.stanceChangedThisTurn.includes(actor.id)) state.stanceChangedThisTurn.push(actor.id)
      const event = { kind: 'onEnterStance' as const, stance: effect.stance }
      if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, event, actor))
      else fireTriggers(state, event, actor)
      return
    }
    case 'heal': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.hp
        const cap = target.relics.some((relic) => relic.defId === 'mark_of_pain') ? 6 : target.maxHp
        target.hp = Math.min(cap, target.maxHp, target.hp + effect.amount)
        if (target.hp > before) note(`${target.name} heals ${target.hp - before}`)
      }
      return
    }
    case 'clearDebuffs': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        target.weak = 0
        target.vulnerable = 0
        note(`${target.name} removes all Weak and Vulnerable`)
      }
      return
    }
    case 'clearTargetBlock': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        if (target.block > 0) note(`${enemyLabel(state.enemies, target)} loses ${target.block} Block`)
        target.block = 0
      }
      return
    }
    case 'discard': {
      const chosen = allocate(actor, context.discardUids, effect.amount, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'discardAny': {
      const chosen = context.discardUids ?? []
      if (new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidDiscardChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = actor.hand.filter((card) => picked.has(card.uid))
      context.discardedByCard = moved.length
      discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'exhaustFromHand': {
      const chosen = allocate(actor, context.exhaustUids, effect.amount, context)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      context.exhaustedCardCost = moved.length === 1
        ? cardCost(faceOf(cardDef(moved[0]!.defId), moved[0]!.upgraded), actor.powers, actor.lostHpThisCombat)
        : undefined
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'gainEnergyFromExhaust': {
      const cost = context.exhaustedCardCost
      if (cost === undefined) return
      const before = actor.energy
      actor.energy = cost === 'X'
        ? Math.min(CAPS.energy, actor.energy * 2)
        : Math.min(CAPS.energy, actor.energy + cost)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'exhaustAny': {
      const chosen = context.exhaustUids ?? []
      const minimum = Math.min(effect.minimum ?? 0, actor.hand.length)
      if (chosen.length < minimum || chosen.length > effect.amount || new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidExhaustChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = actor.hand.filter((card) => picked.has(card.uid))
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustHand': {
      const moved = actor.hand.filter((card) =>
        !effect.except || faceOf(cardDef(card.defId), card.upgraded).type !== effect.except)
      const picked = new Set(moved.map((card) => card.uid))
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      context.exhaustedByCard = moved.length
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustDrawPile': {
      const moved = [...actor.draw]
      actor.draw = []
      exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts their draw pile (${moved.length})`)
      return
    }
    case 'gainBlockPerExhaust':
      return applyEffect(state, actor, {
        kind: 'block', amount: effect.amount * (context.exhaustedByCard ?? 0),
      }, scope, supportScope, context, source)
    case 'hitPerExhaust':
      return applyEffect(state, actor, {
        kind: 'hit', amount: effect.amount, times: context.exhaustedByCard ?? 0,
      }, scope, supportScope, context, source)
    case 'channel': {
      // Reserve the line's position before forced evokes log, but write it only
      // after an Orb was really placed: a lethal forced evoke ends combat first.
      const at = state.log.length
      let channeled = 0
      for (let i = 0; i < amountOf(effect.amount, state, actor, undefined, context); i++) {
        if (channelOrb(state, actor, effect.orb, context)) channeled += 1
        if (combatIsOver(state)) break
      }
      if (channeled > 0) noteAt(at, `${actor.name} channels ${channeled} ${effect.orb}`)
      return
    }
    case 'channelDieOrb': {
      const orb: OrbType = state.die <= 2 ? 'lightning' : state.die <= 4 ? 'frost' : 'dark'
      const at = state.log.length
      if (channelOrb(state, actor, orb, context)) noteAt(at, `${actor.name} channels 1 ${orb}`)
      return
    }
    case 'addDaze': {
      const gained = addDaze(state, actor, effect.amount, effect.pile, actor.id)
      if (gained > 0) note(`${actor.name} gains ${gained} Daze`)
      return
    }
    case 'recoverDiscardTopCosts': {
      const top = actor.discard.at(-1)
      if (!top) return
      const face = faceOf(cardDef(top.defId), top.upgraded)
      if (face.unplayable || cardCost(face, actor.powers, actor.lostHpThisCombat) !== effect.cost) return
      actor.discard = actor.discard.slice(0, -1)
      actor.hand = [...actor.hand, top]
      note(`${actor.name} returns ${face.name} to hand`)
      return
    }
    case 'recoverAllDiscardCosts': {
      const recovered = actor.discard.filter((card) => {
        const face = faceOf(cardDef(card.defId), card.upgraded)
        return !face.unplayable && cardCost(face, actor.powers, actor.lostHpThisCombat) === effect.cost
      })
      if (recovered.length === 0) return
      const uids = new Set(recovered.map((card) => card.uid))
      actor.discard = actor.discard.filter((card) => !uids.has(card.uid))
      actor.hand = [...actor.hand, ...recovered]
      note(`${actor.name} returns ${recovered.length} ${effect.cost}-cost cards to hand`)
      return
    }
    case 'evoke': {
      const times = amountOf(effect.times, state, actor, undefined, context)
      if (times > 0 && actor.orbs.every((orb) => orb == null)) note(`${actor.name} has no orb to evoke`)
      if (times > 0) evokeOrb(state, actor, context, times)
      return
    }
    case 'recurseOrb': {
      const orb = evokeOrb(state, actor, context)
      if (combatIsOver(state)) return
      if (orb) {
        note(`${actor.name} channels 1 ${orb}`)
        channelOrb(state, actor, orb, context)
      }
      return
    }
    case 'fission': {
      const count = actor.orbs.filter((orb) => orb !== null).length
      if (effect.evoke) {
        for (let index = 0; index < count; index++) {
          evokeOrb(state, actor, context)
          if (combatIsOver(state)) return
        }
      } else {
        actor.orbs = actor.orbs.map(() => null)
        if (count > 0) note(`${actor.name} removes ${count} Orbs`)
      }
      applyEffect(state, actor, { kind: 'gainEnergy', amount: count }, scope, supportScope, context, source)
      applyEffect(state, actor, { kind: 'draw', amount: count }, scope, supportScope, context, source)
      return
    }
    case 'removeAllOrbs': {
      const removed = actor.orbs.filter((orb) => orb !== null).length
      actor.orbs = actor.orbs.map(() => null)
      if (removed > 0) note(`${actor.name} removes ${removed} Orbs`)
      return
    }
    case 'gainOrbSlots': {
      actor.orbs = [...actor.orbs, ...Array<null>(effect.amount).fill(null)]
      note(`${actor.name} gains ${effect.amount} Orb slots`)
      return
    }
    case 'gainOrbEvokeBonus': {
      actor.orbEvokeBonus = (actor.orbEvokeBonus ?? 0) + effect.amount
      note(`${actor.name}'s Orb Evoke effects get +${effect.amount}`)
      return
    }
    case 'gainDarkOrbEvokeBonus': {
      actor.darkOrbEvokeBonus = (actor.darkOrbEvokeBonus ?? 0) + effect.amount
      note(`${actor.name}'s Dark Orb Evoke effects get +${effect.amount}`)
      return
    }
    case 'gainOrbEndTurnBonus': {
      actor.orbEndTurnBonus = (actor.orbEndTurnBonus ?? 0) + effect.amount
      note(`${actor.name}'s Orb end-of-turn effects get +${effect.amount}`)
      return
    }
    case 'gainLightningEndTurnBonus': {
      actor.lightningEndTurnBonus = (actor.lightningEndTurnBonus ?? 0) + effect.amount
      note(`${actor.name}'s Lightning Orb end-of-turn effects get +${effect.amount}`)
      return
    }
    case 'lightningTargetsRow':
      // The face-up Power is read by every Lightning resolution boundary.
      return
    case 'triggerOrbEndTurn':
      // Loop resolves here only through its chosen end-turn ability.
      return
    case 'gainWrathAttackDamageBonus': {
      actor.wrathAttackDamageBonus = (actor.wrathAttackDamageBonus ?? 0) + effect.amount
      note(`${actor.name}'s Attacks deal +${effect.amount} damage while in Wrath`)
      return
    }
    case 'gainShivDamageBonus': {
      actor.shivDamageBonus += effect.amount
      note(`${actor.name}'s Shivs deal +${effect.amount} damage`)
      return
    }
    case 'gainCardBlockBonus': {
      actor.cardBlockBonus += effect.amount
      note(`${actor.name}'s Attack and Skill Block gets +${effect.amount}`)
      return
    }
    case 'gainHitPoison': {
      actor.hitPoison += effect.amount
      note(`${actor.name}'s hits apply ${effect.amount} Poison`)
      return
    }
    case 'gainClawCube': {
      actor.clawCubesGainedThisCombat = (actor.clawCubesGainedThisCombat ?? 0) + effect.amount
      note(`${actor.name} gains ${effect.amount} Claw cube`)
      return
    }
    case 'doubleEnergy': {
      const before = actor.energy
      actor.energy = Math.min(effect.max, actor.energy * 2)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainEnergyIfTargetDead': {
      const target = typeof context.enemyUid === 'string'
        ? state.enemies.find((enemy) => enemy.uid === context.enemyUid)
        : undefined
      if (!target?.dead) return
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + effect.amount)
      if (actor.energy > before) note(`${actor.name} gains ${actor.energy - before} Energy`)
      return
    }
    case 'gainStrengthIfTargetDead': {
      const target = typeof context.enemyUid === 'string'
        ? state.enemies.find((enemy) => enemy.uid === context.enemyUid)
        : undefined
      if (!target?.dead) return
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, effect.amount)
      if (actor.strength > before) note(`${actor.name} gains ${actor.strength - before} Strength`)
      return
    }
    case 'execute': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        if (target.hp > effect.hpAtMost) continue
        const name = enemyLabel(state.enemies, target)
        target.hp = 0
        target.dead = true
        state.log = [...state.log, `${who} sets ${name}'s hit points to 0`, `${name} is dead`]
        triggerEnemyDeath(state, target)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'gainBlockFromLastHit': {
      applyEffect(state, actor, { kind: 'block', amount: context.lastHitDamage ?? 0 },
        scope, supportScope, context, source)
      return
    }
    case 'scry': {
      // Scry shows the top X and lets the player bin any of them; the rest go
      // back on top IN THE SAME ORDER (p.24).
      const revealed = actor.draw.slice(0, Math.max(0, effect.amount))
      const chosen = context.scryDiscardUids ?? []
      if (new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !revealed.some((card) => card.uid === uid))) {
        context.invalidScryChoice = true
        return
      }
      const looked = revealed.length
      const tossed = revealed.filter((card) => chosen.includes(card.uid))
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard },
        effect.amount, chosen)
      actor.draw = piles.draw
      const wovenCards = tossed.filter((card) => faceOf(cardDef(card.defId), card.upgraded).scryPlayBonus !== undefined)
      const woven = wovenCards[0]
      discardByCardEffect(state, actor, tossed.filter((card) => !wovenCards.some((weave) => weave.uid === card.uid)), context)
      if (woven) {
        const weave = faceOf(cardDef(woven.defId), woven.upgraded)
        const queued = { ...forgetRetain(woven), scryDamageBonus: weave.scryPlayBonus }
        const copySources = copySourcesFor(weave, actor)
        const sourceNames = copySources.length > 0
          ? [...copySources, copySources.at(-1)!]
          : ['Weave' as const]
        if (context.sourceCardUid) {
          context.doppelgangerCopy = queued
          context.queuedCopySource = 'Weave'
          context.queuedCopyVirtualOnly = false
          context.queuedCopySourceNames = sourceNames
          context.queuedWeaves = wovenCards.slice(1).map(forgetRetain)
          context.queuedCopySources = copySources
          context.consumeQueuedFreeCard = (actor.freeCardsThisTurn ?? 0) > 0
          context.consumeQueuedFreeAttack = (actor.freeAttacksThisTurn ?? 0) > 0
        } else {
          state.pendingCardCopy = {
            playerId: actor.id,
            card: queued,
            energySpent: 0,
            resumePhase: state.phase === 'start' ? 'start' : 'player',
            forcedExhaust: false,
            forcedChoices: null,
            deferredHavocs: [],
            sourceNames,
            queuedWeaves: wovenCards.slice(1).map(forgetRetain),
            queuedCopySources: copySources,
            consumeFreeCard: (actor.freeCardsThisTurn ?? 0) > 0,
            consumeFreeAttack: (actor.freeAttacksThisTurn ?? 0) > 0,
          }
          state.phase = 'copy'
        }
        note(`${actor.name} plays ${weave.name} instead of discarding it`)
      }
      // An empty draw pile means no cards were looked at, so nothing scried.
      if (looked > 0) context.pendingTriggers?.push(
        ...queuedTriggers(state, { kind: 'onScry' }, actor),
      )
      return
    }
    case 'topdeck': {
      const requested = context.topdeckUids ?? []
      if (requested.length !== Math.min(effect.amount, actor.hand.length) ||
        new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidTopdeckChoice = true
        return
      }
      const chosen = allocate(actor, requested, effect.amount, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      const picked = new Set(chosen)
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      actor.draw = addToDrawTop(actor, moved.map(forgetRetain)).draw
      if (moved.length > 0) note(`${actor.name} puts ${moved.length} card on top of their draw pile`)
      return
    }
    case 'recoverDiscard': {
      const required = Math.min(effect.amount, actor.discard.length)
      const requested = context.recoverDiscardUids ??
        (context.recoverDiscardUid === undefined ? [] : [context.recoverDiscardUid])
      if ((context.recoverDiscardUids !== undefined && context.recoverDiscardUid !== undefined) ||
        requested.length !== required || new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.discard.some((card) => card.uid === uid))) {
        context.invalidRecoverChoice = true
        return
      }
      if (requested.length === 0) return
      const selected = new Set(requested)
      const moved = requested.map((uid) => actor.discard.find((card) => card.uid === uid)!)
      actor.discard = actor.discard.filter((card) => !selected.has(card.uid))
      const cleaned = moved.map((card) => effect.retain
        ? { ...forgetRetain(card), retainThisTurn: true }
        : forgetRetain(card))
      if (effect.toHand) actor.hand = [...actor.hand, ...cleaned]
      else actor.draw = addToDrawTop(actor, cleaned).draw
      note(`${actor.name} returns ${moved.length} card${moved.length === 1 ? '' : 's'} to their ${effect.toHand ? 'hand' : 'draw pile'}`)
      return
    }
    case 'recoverExhaust': {
      const required = Math.min(effect.amount, actor.exhaust.length)
      const chosen = context.recoverExhaustUid
      if ((required === 1 && (!chosen || !actor.exhaust.some((card) => card.uid === chosen))) ||
        (required === 0 && chosen !== undefined)) {
        context.invalidRecoverChoice = true
        return
      }
      if (!chosen) return
      const moved = actor.exhaust.find((card) => card.uid === chosen)!
      actor.exhaust = actor.exhaust.filter((card) => card.uid !== chosen)
      const recovered = forgetRetain(moved)
      recovered.counter = undefined
      actor.hand = [...actor.hand, recovered]
      note(`${actor.name} returns ${faceOf(cardDef(moved.defId), moved.upgraded).name} to their hand`)
      return
    }
    case 'searchDraw': {
      const requested = context.searchDrawUids ?? []
      const required = Math.min(effect.amount, actor.draw.length)
      if (requested.length !== required || new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.draw.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = requested.map((uid) => actor.draw.find((card) => card.uid === uid)!)
      const picked = new Set(requested)
      actor.draw = shuffle(state.rng, actor.draw.filter((card) => !picked.has(card.uid)))
      actor.hand = [...actor.hand, ...chosen.map(forgetRetain)]
      if (chosen.length > 0) note(`${actor.name} searches ${chosen.length} card${chosen.length === 1 ? '' : 's'} into their hand`)
      context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      return
    }
    case 'searchDrawAndPlayTwice': {
      const eligible = omniscienceEligibleCards(state, actor)
      const requested = context.searchDrawUids ?? []
      if (requested.length !== Math.min(1, eligible.length) ||
        requested.some((uid) => !eligible.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = eligible.find((card) => card.uid === requested[0])
      actor.draw = shuffle(state.rng, actor.draw.filter((card) => card.uid !== chosen?.uid))
      context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      if (!chosen) return
      const chosenDef = faceOf(cardDef(chosen.defId), chosen.upgraded)
      context.doppelgangerCopy = forgetRetain(chosen)
      context.queuedCopySource = 'Omniscience'
      context.queuedCopyVirtualOnly = false
      context.queuedCopyTwice = true
      context.queuedCopyForcedExhaust = true
      context.queuedCopySources = []
      context.consumeQueuedFreeCard = (actor.freeCardsThisTurn ?? 0) > 0
      context.consumeQueuedFreeAttack = chosenDef.type === 'attack' && (actor.freeAttacksThisTurn ?? 0) > 0
      note(`${actor.name} will play ${chosenDef.name} twice for 0 Energy`)
      return
    }
    case 'drawAndPlayFree': {
      const [drawn] = drawInto(state, actor, 1, context.pendingTriggers)
      if (!drawn) return
      const drawnDef = faceOf(cardDef(drawn.defId), drawn.upgraded)
      if (!cardIsPlayable(drawnDef, state, actor) || (drawnDef.minimumX ?? 0) > 0) {
        if (effect.exhaustNonPower && drawnDef.type !== 'power') {
          actor.hand = actor.hand.filter((card) => card.uid !== drawn.uid)
          exhaustCards(state, actor, [drawn], context)
        } else {
          discardByCardEffect(state, actor, [drawn])
        }
        note(`${actor.name} cannot play ${drawnDef.name} with ${cardDef(context.sourceCardId ?? 'mayhem').name}`)
        return
      }
      state.startTurnProgress = {
        choices: [],
        forcedCard: {
          playerId: actor.id,
          cardUid: drawn.uid,
          sourceCardId: context.sourceCardId ?? 'mayhem',
          exhaustNonPower: effect.exhaustNonPower === true,
        },
      }
      note(`${actor.name} must play ${cardDef(context.sourceCardId ?? 'mayhem').name}'s drawn card for 0 Energy`)
      return
    }
  }
}

/**
 * The one place a player's Block goes up.
 *
 * Three separate sites used to write `player.block` and only this one fired
 * the trigger, so a Frost orb quietly skipped every Block-reacting Power. A
 * single funnel is the only version of this that cannot drift again.
 *
 * The trigger fires only on a real increase: at the 20 Block cap the gain is a
 * no-op, and a Power reacting to a no-op is paying out for nothing.
 */
function grantBlock(
  state: CombatState,
  target: Player,
  amount: number,
  pendingTriggers?: PendingTrigger[],
): void {
  const before = target.block
  target.block = gainBlock(target.block, amount)
  if (target.block <= before) return
  const event = { kind: 'onGainBlock' as const }
  if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, target))
  else fireTriggers(state, event, target)
}

/**
 * The one place cards are drawn.
 *
 * Same reasoning as `grantBlock`: the Start of Turn draw of 5 is the biggest
 * draw in the game and it used to bypass the trigger path entirely, so an
 * on-draw Power saw nothing and an on-shuffle Power missed the reshuffle that
 * the Start of Turn draw is the usual cause of.
 */
function drawInto(
  state: CombatState,
  actor: Player,
  amount: number,
  pendingTriggers?: PendingTrigger[],
): CardInstance[] {
  if (actor.drawLocked) return []
  const handSize = actor.hand.length
  const result = drawCards(state.rng, actor, amount)
  const drawnCards = result.hand.slice(handSize)
  actor.draw = result.draw
  actor.hand = result.hand
  actor.discard = result.discard
  // The reshuffle lands in the MIDDLE of the draw (p.12): cards taken before
  // the pile ran out were drawn first, then it was shuffled, then the rest.
  // Firing all the draws on one side of the shuffle gets the order wrong in
  // both directions.
  for (let i = 0; i < result.drawn; i++) {
    if (result.reshuffled && i === result.reshuffledAfter) {
      actor.shuffledThisCombat = true
      state.log = [...state.log, `${actor.name} shuffles their discard pile back in`]
      if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      else fireTriggers(state, { kind: 'onShuffle' }, actor)
    }
    const event = { kind: 'onDraw' as const, cardType: cardDef(drawnCards[i]!.defId).type }
    if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, actor))
    else fireTriggers(state, event, actor)
    if (drawnCards[i]!.defId === 'slimed' && actor.energy > 0 && state.enemies.some((enemy) =>
      !enemy.dead && enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .some((ability) => ability.kind === 'void'))) {
      actor.energy -= 1
      actor.hand = actor.hand.filter((card) => card.uid !== drawnCards[i]!.uid)
      exhaustCards(state, actor, [drawnCards[i]!])
      state.log = [...state.log, `${actor.name} spends 1 Energy and Exhausts Slimed to Void`]
    }
  }
  return drawnCards
}

/** Take Daze from the one physical ten-card deck shared by every source. */
function addDaze(
  state: CombatState,
  target: Player,
  amount: number,
  pile: 'draw' | 'discard',
  source: string,
): number {
  const inPlay = state.players.reduce((total, player) => total + [
    ...player.draw,
    ...player.hand,
    ...player.discard,
  ].filter((card) => card.defId === 'daze').length, 0)
  const gained = Math.min(amount, Math.max(0, CAPS.daze - inPlay))
  const cards = Array.from({ length: gained }, (_, index) => ({
    uid: `daze-${state.turn}-${source}-${target.id}-${state.log.length}-${index}`,
    defId: 'daze',
    upgraded: false,
  }))
  if (pile === 'draw') target.draw = [...cards, ...target.draw]
  else target.discard = [...target.discard, ...cards]
  return gained
}

function addStatus(
  state: CombatState,
  target: Player,
  defId: 'burn' | 'slimed',
  amount: number,
  source: string,
): number {
  const inPlay = state.players.reduce((total, player) => total + [
    ...player.draw, ...player.hand, ...player.discard,
  ].filter((card) => card.defId === 'burn' || card.defId === 'slimed').length, 0)
  const gained = Math.min(amount, Math.max(0, CAPS.status - inPlay))
  const cards = Array.from({ length: gained }, (_, index) => ({
    uid: `status-${state.turn}-${source}-${target.id}-${state.log.length}-${index}`,
    defId,
    upgraded: false,
  }))
  target.discard = addToDiscardTop(target, cards).discard
  return gained
}

/** Exhaust cards once, returning Status cards to their shared supply (p.24). */
function exhaustCards(
  state: CombatState,
  actor: Player,
  cards: readonly Player['hand'][number][],
  context?: PlayContext,
): void {
  const lasting = cards
    .filter((held) => cardDef(held.defId).owner !== 'status')
    .map(forgetRetain)
  actor.exhaust = [...actor.exhaust, ...lasting]
  for (const card of cards) {
    if (context?.pendingExhaustTriggers) {
      context.pendingExhaustTriggers.push({ playerId: actor.id, card: forgetRetain(card) })
    } else {
      resolveExhaustReaction(state, actor, card)
    }
  }
}

function resolveExhaustReaction(state: CombatState, actor: Player, card: CardInstance): void {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  for (const effect of def.exhaustReaction?.effects ?? []) {
    applyEffect(state, actor, effect, 'enemy', 'self', {
      enemyUid: livingEnemies(state)[0]?.uid ?? null,
      playerId: actor.id,
    }, `${actor.name}'s ${def.name}`)
  }
  fireTriggers(state, { kind: 'onExhaust' }, actor)
}

/** Discard from a card effect, deferring reactions until its printed text ends (p.12). */
function discardByCardEffect(
  state: CombatState,
  actor: Player,
  cards: readonly CardInstance[],
  context?: PlayContext,
): void {
  if (cards.length === 0) return
  const uids = new Set(cards.map((card) => card.uid))
  const discarded = cards.map(forgetRetain)
  actor.hand = actor.hand.filter((card) => !uids.has(card.uid))
  actor.draw = actor.draw.filter((card) => !uids.has(card.uid))
  actor.discard = [...actor.discard.filter((card) => !uids.has(card.uid)), ...discarded]
  if (!state.discardedThisTurn.includes(actor.id)) state.discardedThisTurn.push(actor.id)
  state.log = [...state.log, `${actor.name} discards ${cards.length}`]

  if (context?.pendingDiscards) {
    context.pendingDiscards.push({ playerId: actor.id, cards: discarded })
    return
  }
  resolveDiscardReactions(state, actor, discarded)
}

function resolveDiscardReactions(
  state: CombatState,
  actor: Player,
  cards: readonly CardInstance[],
): void {
  for (const held of cards) {
    const def = faceOf(cardDef(held.defId), held.upgraded)
    if (!def.discardReaction) continue
    for (const effect of def.discardReaction.effects) {
      applyEffect(state, actor, effect, 'enemy', 'self', { enemyUid: null, playerId: actor.id }, def.name)
    }
    if (def.discardReaction.exhaust) {
      actor.hand = actor.hand.filter((card) => card.uid !== held.uid)
      actor.draw = actor.draw.filter((card) => card.uid !== held.uid)
      actor.discard = actor.discard.filter((card) => card.uid !== held.uid)
      exhaustCards(state, actor, [held])
      state.log = [...state.log, `${actor.name} exhausts ${def.name}`]
    }
  }
  fireTriggers(state, { kind: 'onDiscard' }, actor)
}

/**
 * The uids this effect actually takes, and whether the player paid what they
 * owed.
 *
 * This is the ONLY place a consuming clause is validated, and it runs as the
 * clause resolves, against the hand as it stands right then. An earlier
 * version also pre-checked the whole card up front against the hand the player
 * held BEFORE the card started; that rejected Acrobatics ("Draw 3 cards.
 * Discard 1 card.") whenever the discarded card was one of the three just
 * drawn, which is the ordinary way to play it. Two validators reading two
 * different hands is one validator too many.
 *
 * A card asking for more than the hand can pay is paid in full by what there
 * is, exactly as it would be at the table: discarding your only other card
 * settles a "discard 2".
 */
function allocate(
  actor: Player,
  uids: readonly string[] | undefined,
  amount: number,
  context: PlayContext,
): string[] {
  const spent = (context.spentUids ??= new Set<string>())
  const usable = (uids ?? []).filter(
    (uid, index, all) =>
      all.indexOf(uid) === index &&
      !spent.has(uid) &&
      actor.hand.some((held) => held.uid === uid),
  )
  // The played card has already left hand, so what remains is exactly the pool
  // this clause may take from.
  const required = Math.min(amount, actor.hand.length)
  const taken = usable.slice(0, required)
  if (taken.length < required) context.shortfall = true
  for (const uid of taken) spent.add(uid)
  return taken
}

/** Whether playing this card reveals hidden cards before asking for a choice. */
export function cardNeedsChoicePreview(def: CardDef, state?: CombatState, actor?: Player): boolean {
  if (def.type === 'power' && def.resolvesOnPlay !== true) return false
  let drew = false
  for (const effect of def.effects) {
    if (state && actor && !effectIsActive(effect, state, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') return true
    if (effect.kind === 'draw') drew = true
    if (effect.kind === 'scry' || (drew && (effect.kind === 'discard' || effect.kind === 'topdeck'))) return true
  }
  return false
}

/**
 * Privately previews a post-reveal choice without advancing the real RNG or
 * changing combat. The played card is held outside every pile, as it will be
 * during the eventual atomic play.
 */
export function previewCardChoice(
  state: CombatState,
  playerId: string,
  cardUid: string,
): CardChoicePreview | null {
  const forced = state.startTurnProgress?.forcedCard
  if (state.phase !== 'player' && !(state.phase === 'start' && forced?.playerId === playerId &&
    forced.cardUid === cardUid)) return null
  const player = findPlayer(state, playerId)
  const held = player?.hand.find((card) => card.uid === cardUid)
  if (!player || player.dead || !held) return null
  const def = faceOf(cardDef(held.defId), held.upgraded)
  const printedCost = forced?.cardUid === cardUid ? 0 : playCost(def, player, held)
  const cost = printedCost === 'X' ? player.energy : printedCost
  if (reachedTimeWarpLimit(state, player) || !cardIsPlayable(def, state, player) ||
    cost > player.energy || !cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return { kind: 'search', cards: effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor) }
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor), [])
      drew = true
    } else if (effect.kind === 'scry') {
      return { kind: 'scry', cards: actor.draw.slice(0, effect.amount) }
    } else if (drew && effect.kind === 'discard') {
      return { kind: 'discard', cards: actor.hand }
    } else if (drew && effect.kind === 'topdeck') {
      return { kind: 'topdeck', cards: actor.hand }
    }
  }
  return null
}

/**
 * Effects that have to be pointed at an enemy before the card can resolve.
 *
 * `evoke` is here because an evoked Lightning or Dark orb picks a target: left
 * out, Dual Cast silently aimed at the first living enemy and the Defect could
 * not direct their biggest starter card.
 */
const ENEMY_EFFECTS = [
  'hit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'multiplyPoison',
  'evoke', 'recurseOrb', 'clearTargetBlock', 'hitPerExhaust', 'execute',
]

/**
 * Whether this clause can reach an enemy at all, for this player.
 *
 * Conservative on purpose: it answers "no" only when the clause CERTAINLY
 * touches nobody. A counted attack is the case that matters — Barrage swings
 * once per Orb, and with none charged it swings zero times, so asking the
 * player to point it at something is asking for a decision that changes
 * nothing. A bonus reads board state this function is not given, so any bonus
 * counts as "might swing".
 */
function reachesEnemy(
  effect: Effect,
  actor: CountablePlayer | undefined,
  energySpent?: number,
): boolean {
  if (!ENEMY_EFFECTS.includes(effect.kind)) return false
  if (actor && effect.when?.kind === 'inStance' && actor.stance !== effect.when.stance) return false
  if (actor && effect.when?.kind === 'notInStance' && actor.stance === effect.when.stance) return false
  if (effect.kind === 'hitPerExhaust') return !actor || actor.hand === null || actor.hand.length > 1
  if (effect.kind === 'evoke') {
    if (!actor) return true
    const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
      (effect.times.per ? countOf(effect.times.per, actor, undefined,
        effect.times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent) : 0)
    return times > 0 && actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind === 'recurseOrb') {
    return !actor || actor.orbs.some((orb) => orb === 'lightning' || orb === 'dark')
  }
  if (effect.kind !== 'hit' || effect.times === undefined || !actor) return true
  const times = effect.times
  if (typeof times === 'number') return times > 0
  if (times.bonus) return true
  return times.base + (times.per
    ? countOf(times.per, actor, undefined,
      times.per === 'energySpent' && energySpent === undefined ? 1 : energySpent)
    : 0) > 0
}

/**
 * Whether this card asks the player to point at an enemy.
 *
 * Only single-target scopes need a choice: `allEnemies` hits everything, and a
 * card with no enemy-facing effect needs nothing. A `row` scope does need one,
 * since the chosen enemy is what picks the row.
 *
 * Exported so the UI prompts for exactly what the engine will require. Two
 * copies of this rule drifted apart once: the UI collected a target the engine
 * then discarded. `actor` is what lets both sides agree that a zero-swing
 * attack needs no target; without it the UI asked, and then nothing happened.
 */
export function cardNeedsEnemy(
  def: CardDef,
  actor?: CountablePlayer,
  includeEvokes = true,
  energySpent?: number,
  forActivation = false,
): boolean {
  if (def.type === 'power' && (def.trigger || (def.activeAbility && !forActivation))) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  return effects.some((effect) =>
    (includeEvokes || (effect.kind !== 'evoke' && effect.kind !== 'recurseOrb')) &&
      reachesEnemy(effect, actor, energySpent))
}

/** Independent printed targets collected before an atomic card play. */
export function cardEnemyChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (
    effect.kind === 'poisonChoices' || effect.kind === 'hitChoices' ? effect.targets : 0
  ), 0)
}

export function cardPlayerChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
}

export function cardModeIsAvailable(
  def: CardDef,
  state: CombatState,
  player: Player,
  mode: number,
  drawCount = player.draw.length,
  sourceCardUid?: string,
): boolean {
  const effects = def.modes?.[mode]?.effects
  return effects !== undefined &&
    (!effects.some((effect) => effect.kind === 'copyLastAllyAttack') ||
      Boolean(latestPlayableAllyAttack(state, player, sourceCardUid, drawCount)))
}

/** Mandatory targets for a card that spends every Shiv the actor currently holds. */
export function cardShivChoiceCount(
  def: CardDef,
  actor: Pick<Player, 'shivs'>,
  mode?: number,
): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.some((effect) => effect.kind === 'useAllShivs') ? actor.shivs : 0
}

export type EvokeChoice = { index: number; options: { slot: number; orb: OrbType }[] }

function effectEvokePlan(
  effects: readonly Effect[],
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  energySpent = 0,
) {
  const orbs = [...actor.orbs]
  const chosen: OrbType[] = []
  let index = 0
  let next: EvokeChoice | null = null
  let invalid = false

  const evoke = (times = 1) => {
    const options = orbs.flatMap((orb, slot) => orb ? [{ slot, orb }] : [])
    if (options.length === 0) return true
    const slot = slots[index]
    if (slot === undefined) {
      next = { index, options }
      return false
    }
    const picked = options.find((option) => option.slot === slot)
    if (!picked) {
      invalid = true
      return false
    }
    chosen.push(...Array<OrbType>(times).fill(picked.orb))
    orbs[slot] = null
    index += 1
    return true
  }

  for (const effect of effects) {
    if (effect.when?.kind === 'orbsAtLeast' &&
      orbs.filter((orb) => orb !== null).length < effect.when.amount) continue
    if (effect.kind === 'channel' || effect.kind === 'channelDieOrb') {
      const amount = effect.kind === 'channel'
        ? typeof effect.amount === 'number'
          ? effect.amount
          : effect.amount.base + (effect.amount.per
            ? countOf(effect.amount.per, actor, undefined, energySpent) * (effect.amount.scale ?? 1)
            : 0)
        : 1
      for (let count = 0; count < amount; count++) {
        if (orbs.every((orb) => orb !== null) && !evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        if (open >= 0) orbs[open] = effect.kind === 'channel' ? effect.orb : 'lightning'
      }
    } else if (effect.kind === 'evoke' || effect.kind === 'recurseOrb' ||
      (effect.kind === 'fission' && effect.evoke)) {
      if (effect.kind === 'fission') {
        while (orbs.some((orb) => orb !== null)) {
          if (!evoke()) return { chosen, index, next, invalid, orbs }
        }
        continue
      }
      if (effect.kind === 'recurseOrb') {
        if (!evoke()) return { chosen, index, next, invalid, orbs }
        const open = orbs.indexOf(null)
        const orb = chosen.at(-1)
        if (open >= 0 && orb) orbs[open] = orb
        continue
      }
      const times = typeof effect.times === 'number' ? effect.times : effect.times.base +
        (effect.times.per ? countOf(effect.times.per, actor, undefined, energySpent) : 0)
      if (times > 0 && !evoke(times)) return { chosen, index, next, invalid, orbs }
    }
  }
  return { chosen, index, next, invalid, orbs }
}

function evokePlan(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
) {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effectEvokePlan(effects, actor, slots, energySpent)
}

/** The next Orb choice a staged card needs, after its earlier choices. */
export function nextEvokeChoice(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
): EvokeChoice | null {
  return evokePlan(def, actor, slots, mode, energySpent).next
}

/** Orb types already chosen by a staged play, including slots filled earlier in that same card. */
export function chosenEvokeOrbs(
  def: CardDef,
  actor: Pick<Player, 'orbs'> & CountablePlayer,
  slots: readonly number[],
  mode?: number,
  energySpent = 0,
): OrbType[] {
  return evokePlan(def, actor, slots, mode, energySpent).chosen
}

/** Next legal target after applying every already-staged Evoke in sequence. */
export function evokeTargetProgress(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slots: readonly number[],
  targets: readonly (string | null | undefined)[],
  mode?: number,
  energySpent = 0,
): { index: number; options: { uid: string; label: string }[]; complete: boolean; endedCombat: boolean } {
  const chosen = evokePlan(def, actor, slots, mode, energySpent).chosen
  const simulation = clone(state)
  const simulationActor = findPlayer(simulation, actor.id)
  if (!simulationActor) return { index: 0, options: [], complete: false, endedCombat: false }
  for (let index = 0; index < chosen.length; index++) {
    if (combatIsOver(simulation)) return { index, options: [], complete: true, endedCombat: true }
    const orb = chosen[index]!
    const target = targets[index]
    if (orb === 'frost') {
      if (target !== null) return { index, options: [], complete: false, endedCombat: false }
      continue
    }
    const options = orb === 'lightning'
      ? lightningTargetOptions(simulation, simulationActor, def.id)
      : livingEnemies(simulation).map((enemy) => ({
        uid: enemy.uid, label: enemyLabel(simulation.enemies, enemy),
      }))
    if (typeof target !== 'string' || !options.some((option) => option.uid === target)) {
      return { index, options, complete: false, endedCombat: false }
    }
    if (!applyOrbEvokeEffect(simulation, simulationActor, orb, target, def.id)) {
      return { index, options, complete: false, endedCombat: false }
    }
  }
  return { index: chosen.length, options: [], complete: true, endedCombat: false }
}

function cardRequiresChosenEnemy(
  def: CardDef,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
): boolean {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects : undefined
  return cardNeedsEnemy(effects ? { ...def, modes: undefined, effects } : def, actor, includeEvokes, energySpent)
}

function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
  mode?: number,
): boolean {
  if (!cardRequiresChosenEnemy(def, actor, includeEvokes, energySpent, mode)) return false
  return resolveEnemyTargets(state, def.target ?? 'enemy', chosenUid).length === 0
}

/**
 * Who a supportive effect lands on.
 *
 * The card-level `supportTarget` says the card asks you to choose an ally; the
 * effect's own `toChosen` says whether THIS clause is the one that goes to
 * them. Splitting the two is what keeps "2 Block to any player. Enter Calm."
 * from handing the Watcher's stance to somebody else.
 */
function supportTargets(
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

function hasInvalidChosenPlayer(
  state: CombatState,
  def: CardDef,
  chosenId: unknown,
): boolean {
  if (def.supportTarget !== 'anyPlayer') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  if (!effects.some((effect) => 'toChosen' in effect && effect.toChosen)) return false
  if (chosenId === null) return false
  if (typeof chosenId !== 'string' || chosenId.length === 0) return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead
}

function hasInvalidRowSwitch(
  state: CombatState,
  effects: readonly Effect[],
  chosenId: unknown,
  actor: Player,
): boolean {
  if (!effects.some((effect) => effect.kind === 'switchRows') || chosenId === null || chosenId === undefined) {
    return false
  }
  if (typeof chosenId !== 'string') return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead || chosen.id === actor.id
}

function resolveEnraged(state: CombatState, actor: Player): void {
  for (const enemy of state.enemies) {
    const ability = enemyDef(enemy.defId, enemy.ascension).ability
    if (enemy.dead || ability?.kind !== 'enraged' || state.turn < ability.fromTurn) continue
    const blockBefore = actor.block
    const outcome = damagePlayer(state, actor, ability.damage)
    const name = enemyLabel(state.enemies, enemy)
    const lost = outcome.hpLost
    const blocked = blockBefore - actor.block
    state.log = [
      ...state.log,
      lost > 0
        ? `${name}'s Enraged hit ${actor.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : outcome.fullyBlocked
          ? `${actor.name} blocked ${name}'s Enraged (${blocked} spent)`
          : `${name}'s Enraged did no damage to ${actor.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`,
    ]
    if (actor.dead) {
      state.log = [...state.log, `${actor.name} has fallen`]
      return
    }
  }
}

/** Completes nested Havocs from the innermost card back to the outermost. */
function finishDeferredHavocs(
  state: CombatState,
  actor: Player,
  deferred: readonly DeferredHavoc[],
): PendingTrigger[] {
  const remaining = [...deferred]
  const pendingTriggers: PendingTrigger[] = []
  while (remaining.length > 0) {
    const { card, exhaust, remainingEffects, virtualOnly, copySourceNames, copyResumePhase } = remaining.pop()!
    if (combatIsOver(state)) return pendingTriggers
    const def = faceOf(cardDef(card.defId), card.upgraded)
    if (remainingEffects?.length) {
      const context = resolutionContext(
        { enemyUid: null, playerId: actor.id }, def, card, 0,
        virtualOnly === true || Boolean(copySourceNames?.length),
      )
      for (const effect of remainingEffects) {
        applyEffect(state, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', context)
        if (combatIsOver(state)) return pendingTriggers
      }
      pendingTriggers.push(...(context.pendingTriggers ?? []))
    }
    if (copySourceNames?.length) {
      if (def.type === 'attack') actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
      fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
      if (combatIsOver(state)) return pendingTriggers
      if (def.type === 'skill') resolveEnraged(state, actor)
      if (combatIsOver(state)) return pendingTriggers
      state.pendingCardCopy = {
        playerId: actor.id,
        card: { ...card },
        energySpent: 0,
        resumePhase: copyResumePhase ?? 'player',
        forcedExhaust: exhaust,
        forcedChoices: null,
        deferredHavocs: remaining,
        sourceNames: copySourceNames,
      }
      state.phase = 'copy'
      state.log = [...state.log,
        `${actor.name}'s ${copySourceNames[0]} copy finished; ${def.name} remains to resolve`]
      return pendingTriggers
    }
    if (!virtualOnly) {
      if (exhaust) exhaustCards(state, actor, [card])
      else actor.discard = [...actor.discard, card]
    }
    if (combatIsOver(state)) return pendingTriggers
    if (def.type === 'attack') actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
    fireTriggers(state, { kind: 'onPlayCard', cardType: def.type }, actor, card.uid)
    if (combatIsOver(state)) return pendingTriggers
    if (def.type === 'skill') resolveEnraged(state, actor)
  }
  return pendingTriggers
}

function settleForbiddenPendingCopy(state: CombatState, actor: Player): CombatState {
  const settled = settle(state)
  if (!settled.pendingCardCopy) return settled
  return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
    ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
    : settled
}

function cardResolutionChoicesAreValid(
  state: CombatState,
  player: Player,
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
  energySpent: number,
  sourceCardUid?: string,
): boolean {
  if (effects.some((effect) => effect.kind === 'copyLastAllyAttack') &&
    !latestPlayableAllyAttack(state, player, sourceCardUid)) {
    return false
  }
  const mandatoryShivs = cardShivChoiceCount(def, player, context.mode)
  const discarded = context.discardUids?.length ?? 0
  const gainedShivs = effects.reduce((sum, effect) => sum + (effect.kind === 'gainShiv'
    ? effect.amount
    : effect.kind === 'gainShivPerDiscard' ? discarded + effect.bonus : 0), 0)
  const shivChoices = context.shivEnemyUids ?? []
  if (shivChoices.length < mandatoryShivs ||
    shivChoices.length > mandatoryShivs + overflowShivCount(state, gainedShivs) ||
    shivChoices.some((uid, index) => (index < mandatoryShivs && uid === null) ||
      (uid !== null && !livingEnemies(state).some((enemy) => enemy.uid === uid)))) return false

  const enemyChoiceCount = cardEnemyChoiceCount(def, context.mode)
  const enemyChoices = context.enemyUids ?? []
  const requiresDistinct = effects.some((effect) => effect.kind === 'hitChoices' && effect.distinct)
  if (enemyChoiceCount > 0 && (
    enemyChoices.length !== enemyChoiceCount ||
    (requiresDistinct && new Set(enemyChoices).size !== enemyChoices.length) ||
    enemyChoices.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))
  )) return false
  const playerChoiceCount = cardPlayerChoiceCount(def, context.mode)
  if (playerChoiceCount > 0 && (
    context.playerIds?.length !== playerChoiceCount ||
    context.playerIds.some((id) => !state.players.some((candidate) => candidate.id === id && !candidate.dead))
  )) return false

  const recover = effects.find((effect) => effect.kind === 'recoverDiscard')
  if (recover) {
    const required = Math.min(recover.amount, player.discard.length)
    const chosen = context.recoverDiscardUids ??
      (context.recoverDiscardUid === undefined ? [] : [context.recoverDiscardUid])
    if ((context.recoverDiscardUids !== undefined && context.recoverDiscardUid !== undefined) ||
      chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.discard.some((card) => card.uid === uid))) return false
  }
  const exhume = effects.find((effect) => effect.kind === 'recoverExhaust')
  if (exhume) {
    const required = Math.min(exhume.amount, player.exhaust.length)
    const chosen = context.recoverExhaustUid
    if ((required === 1 && (!chosen || !player.exhaust.some((card) => card.uid === chosen))) ||
      (required === 0 && chosen !== undefined)) return false
  }
  const search = effects.find((effect) => effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice')
  if (search) {
    const chosen = context.searchDrawUids ?? []
    const eligible = search.kind === 'searchDraw' ? player.draw : omniscienceEligibleCards(state, sourceCardUid
      ? { ...player, hand: player.hand.filter((card) => card.uid !== sourceCardUid) }
      : player)
    const required = Math.min(search.kind === 'searchDraw' ? search.amount : 1, eligible.length)
    if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !eligible.some((card) => card.uid === uid))) return false
  }

  const plan = evokePlan(def, player, context.evokeSlots ?? [], context.mode, energySpent)
  if (plan.invalid || plan.next || plan.index !== (context.evokeSlots?.length ?? 0)) return false
  if (plan.chosen.length > 0 && (!context.evokeSlots || !context.evokeEnemyUids)) return false
  if (context.evokeEnemyUids) {
    if (!context.evokeSlots || context.evokeEnemyUids.length > plan.chosen.length) return false
    const targetPlan = evokeTargetProgress(
      def, state, player, context.evokeSlots, context.evokeEnemyUids, context.mode, energySpent,
    )
    if (!targetPlan.complete || targetPlan.index !== context.evokeEnemyUids.length) return false
  }
  return !needsChosenEnemy(state, def, context.enemyUid, player, !context.evokeEnemyUids, energySpent, context.mode) &&
    !hasInvalidChosenPlayer(state, def, context.playerId) &&
    !hasInvalidRowSwitch(state, effects, context.switchWithPlayerId, player)
}

function cleanupPlayedCard(
  state: CombatState,
  actor: Player,
  held: CardInstance,
  def: CardDef,
  context: PlayContext,
  forcedExhaust = false,
): void {
  const played = context.sourceCounter === undefined
    ? forgetRetain(held)
    : { ...forgetRetain(held), counter: context.sourceCounter }
  if (context.sourceAttached) return
  if (def.exhaust || forcedExhaust ||
    (def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills))) {
    exhaustCards(state, actor, [played], context)
  } else if (def.type === 'power') {
    actor.powers = [...actor.powers, played]
  } else if (def.toDrawTop) {
    actor.draw = addToDrawTop(actor, [played]).draw
  } else {
    actor.discard = [...actor.discard, played]
  }
}

/**
 * Plays a card from a player's hand. Returns the same state reference when the
 * play is illegal: not that player's card, not enough energy, wrong phase.
 */
/** Printed enemy reactions wait until the current card has resolved all text. */
function resolvePendingEnemyReactions(state: CombatState, actor: Player, context: PlayContext): void {
  for (const uid of new Set(context.pendingEnemyDeathUids ?? [])) {
    const enemy = state.enemies.find((candidate) => candidate.uid === uid)
    if (enemy?.dead) triggerEnemyDeath(state, enemy)
  }
  const damage = new Map<string, number>()
  for (const event of context.pendingEnemyDamage ?? []) {
    damage.set(event.enemyUid, (damage.get(event.enemyUid) ?? 0) + event.amount)
  }
  const attacked = new Set(context.pendingAttackTargets ?? [])
  for (const enemy of state.enemies) {
    const abilities = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
    const lost = damage.get(enemy.uid) ?? 0
    if (lost > 0) {
      const curl = abilities.find((ability) => ability.kind === 'curlUp')
      if (!enemy.dead && curl?.kind === 'curlUp' && !enemy.abilityUsed) {
        enemy.abilityUsed = true
        enemy.block = gainBlock(enemy.block, curl.block)
        state.log = [...state.log, `${enemyLabel(state.enemies, enemy)}'s Curl Up gained Block`]
      }
      if (abilities.some((ability) => ability.kind === 'shift')) grantShiftBlock(state, enemy, lost)
      triggerAngry(state, enemy, (context.pendingEnemyDamage ?? [])
        .filter((event) => event.enemyUid === enemy.uid).length)
      if (attacked.has(enemy.uid) && abilities.some((ability) => ability.kind === 'reactiveReroll')) {
        state.die = nextInt(state.rng, 6) + 1
        state.log = [...state.log, `${enemyLabel(state.enemies, enemy)} rerolled enemy intents to ${state.die}`]
      }
    }
    const thorns = abilities.find((ability) => ability.kind === 'thorns')
    const sharpHide = abilities.find((ability) => ability.kind === 'sharpHide')
    if (!attacked.has(enemy.uid) ||
      (thorns?.kind !== 'thorns' && (enemy.dead || sharpHide?.kind !== 'sharpHide'))) continue
    const amount = thorns?.kind === 'thorns'
      ? (enemy.abilityCubes ?? 0) * thorns.damagePerCube
      : sharpHide?.kind === 'sharpHide' ? sharpHide.damage : 0
    if (amount <= 0) continue
    const block = actor.block
    const outcome = damagePlayer(state, actor, amount)
    const lostHp = outcome.hpLost
    const blocked = block - actor.block
    state.log = [...state.log, lostHp > 0
      ? `${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'} hit ${actor.name} for ${lostHp}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
      : outcome.fullyBlocked ? `${actor.name} blocked ${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'}`
        : `${enemyLabel(state.enemies, enemy)}'s ${thorns ? 'Thorns' : 'Sharp Hide'} did no damage to ${actor.name}`]
    if (actor.dead) {
      state.log = [...state.log, `${actor.name} has fallen`]
      return
    }
  }
}

export function playCard(
  state: CombatState,
  playerId: string,
  cardUid: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  const forced = state.startTurnProgress?.forcedCard
  const forcedPlay = (state.phase === 'start' || state.phase === 'player') &&
    forced?.playerId === playerId && forced.cardUid === cardUid
  if (forced && !forcedPlay) return state
  if (state.phase !== 'player' && !forcedPlay) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead) return state

  const held = player.hand.find((card) => card.uid === cardUid)
  if (!held) return state

  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (player.cardPlayLocked) return forcedPlay ? abandonForcedCard(state, playerId) : state
  if (reachedTimeWarpLimit(state, player)) {
    return forcedPlay ? abandonForcedCard(state, playerId) : state
  }
  if (!cardIsPlayable(def, state, player)) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!, player.draw.length, held.uid)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  const resolvesOnPlay = def.type !== 'power' || def.resolvesOnPlay === true
  const printedCost = forcedPlay ? 0 : playCost(def, player, held)
  if (def.cost === 'X' && printedCost !== 'X' && printedCost < (def.minimumX ?? 0)) return state
  const xCost = printedCost === 'X'
  if (xCost && (!Number.isInteger(context.energySpent) || context.energySpent! < (def.minimumX ?? 0) ||
    context.energySpent! > player.energy)) return state
  if (!xCost && context.energySpent !== undefined && context.energySpent !== 0) return state
  const cost = xCost ? context.energySpent! : printedCost
  const effectEnergy = def.cost === 'X' ? cost : 0
  const miracleOnCard = context.spendMiracle === true
  if (forcedPlay && miracleOnCard) return state
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  // Choices are checked together at the trust boundary. The same validator is
  // reused when the physical card resolves after its separately targeted copy.
  if (resolvesOnPlay && !cardResolutionChoicesAreValid(
    state, player, def, effects, context, effectEnergy, held.uid,
  )) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)
  const akabeko = def.type === 'attack' && (actor.akabekoAttacks ?? 0) > 0
  if (akabeko) {
    actor.strength = gainStrength(actor.strength, 1)
    actor.akabekoAttacks!--
  }

  // A card can be played twice by only one effect; later effects wait for the
  // next valid card (rulebook p.24). Burst itself explicitly cannot be copied.
  // The first resolution below is the virtual copy; the physical original
  // stays outside every pile and resolves through `playCardCopy` afterwards.
  const copySources = copySourcesFor(def, actor)
  const doubled = copySources.length > 0
  consumeCopySource(actor, copySources)
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: held.upgraded,
    copied: doubled,
    energy: cost,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids, effectEnergy),
      def.supportTarget ?? 'self', presentationCardContext(def, effects, context)),
  })

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  const forcedChoices = forcedPlay ? [...(state.startTurnProgress?.choices ?? [])] : null
  if (forcedPlay) next.startTurnProgress = undefined
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost
  actor.nextCardCost = null
  if ((actor.freeCardsThisTurn ?? 0) > 0) actor.freeCardsThisTurn = actor.freeCardsThisTurn! - 1
  if (def.type === 'attack' && (actor.freeAttacksThisTurn ?? 0) > 0) {
    actor.freeAttacksThisTurn = actor.freeAttacksThisTurn! - 1
  }
  if (miracleOnCard) {
    actor.miracles -= 1
    actor.energy += 1
    next.log = [...next.log, `${actor.name} spends a Miracle toward ${def.name}`]
  }
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'power') actor.powerPlayedThisTurn = true
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      { playerId: actor.id, card: forgetRetain(held), copied: doubled },
    ]
  }

  // Logged before its effects resolve: appended afterwards, a kill the card
  // caused reads as OLDER than the card, which is nonsense in a newest-first
  // log.
  next.log = [...next.log, doubled
    ? `${actor.name} played ${def.name} copy (${copySources[0]})`
    : `${actor.name} played ${def.name}`]

  const scope: TargetScope = def.target ?? 'enemy'
  const supportScope: TargetScope = def.supportTarget ?? 'self'
  // A Power with a trigger does nothing when played: its effects are what the
  // trigger does, every time it fires. Resolving them here as well would pay
  // out Demon Form's Strength immediately AND at every Start of Turn.
  // `spentUids` and `shortfall` are this play's verdict, not the caller's
  // request, so they go on a copy. The caller's object is theirs: in the UI it
  // is assembled out of React state, and writing a scratch field back into it
  // would be a mutation from a function that is otherwise pure.
  const ctx = resolutionContext(context, def, held, effectEnergy, doubled)
  let remainingEffects: Effect[] | undefined
  if (resolvesOnPlay) {
    for (const [index, effect] of effects.entries()) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
      if (invalidPlayChoice(ctx)) return state
      // Combat endings are immediate (p.13), including halfway through a
      // card. Nothing printed later, nor cleanup or play triggers, resolves.
      if (cardResolutionIsOver(next, ctx, actor)) {
        if (akabeko) actor.strength = Math.max(0, actor.strength - 1)
        return finishForcedCardPlay(settle(next), forcedChoices)
      }
      if (ctx.doppelgangerCopy) {
        remainingEffects = effects.slice(index + 1)
        break
      }
    }
  }
  if (akabeko) actor.strength = Math.max(0, actor.strength - 1)

  // Havoc's child is part of Havoc's resolution. Its own cleanup, card-play
  // triggers, and Enraged reaction therefore wait until that child finishes.
  // A Havoc drawn by another Havoc extends the same small stack.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...(forced?.deferredHavocs ?? []),
      { card: forgetRetain(held), exhaust: def.exhaust === true ||
        (forcedPlay && forced.exhaustNonPower && def.type !== 'power') || corrupt,
      ...(doubled ? {
        copySourceNames: copySources,
        copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
      } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [
      ...(forced?.pendingTriggers ?? []),
      ...(ctx.pendingTriggers ?? []),
    ]
    if (forcedChoices) {
      next.startTurnProgress.choices = forcedChoices.map((choice) => ({ ...choice }))
    }
    return settle(next)
  }

  // Survivor reads "2 Block. Discard 1 card." — the discard is the COST, not a
  // suggestion. Off the network an empty or bogus list would otherwise buy the
  // card's effects for nothing. The whole play is resolved into a clone first,
  // so refusing it here costs the caller nothing and still signals illegality
  // the way every other refusal does: by handing back the very same reference.
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  for (const pending of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveDiscardReactions(next, owner, pending.cards)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (ctx.doppelgangerCopy) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.pendingCardCopy = {
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : 'player',
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices,
      deferredHavocs: [
        ...(forced?.deferredHavocs ?? []),
        {
          card: forgetRetain(held),
          exhaust: def.exhaust === true ||
            (forcedPlay && forced.exhaustNonPower && def.type !== 'power') || corrupt,
          remainingEffects,
          ...(doubled ? {
            copySourceNames: copySources,
            copyResumePhase: state.phase === 'start' ? 'start' as const : 'player' as const,
          } : {}),
        },
      ],
      deferredTriggers: [
        ...(forced?.pendingTriggers ?? []),
        ...(ctx.pendingTriggers ?? []),
      ],
      sourceNames: ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
        ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
        : [ctx.queuedCopySource ?? 'Doppelganger']),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }

  if (!doubled) cleanupPlayedCard(next, actor, held, def, ctx,
    forcedPlay && forced.exhaustNonPower && def.type !== 'power')

  for (const pending of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveExhaustReaction(next, owner, pending.card)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  for (const pending of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pending.enemyUid }, owner)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  }

  // "Abilities triggered by a card do not take effect until the card has
  // finished resolving all of its text" (p.12). A doubled card stays outside
  // every pile until both resolutions finish, so only that exceptional cleanup waits.
  // `held.uid` is excluded: a Power that reacts to cards being played was not
  // in front of you when THIS card was played, so it does not see it.
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, held.uid)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (doubled) {
    next.pendingCardCopy = {
      playerId: actor.id,
      card: { ...held },
      energySpent: effectEnergy,
      resumePhase: state.phase === 'start' ? 'start' : 'player',
      forcedExhaust: forcedPlay && forced.exhaustNonPower && def.type !== 'power',
      forcedChoices,
      deferredHavocs: [...(forced?.deferredHavocs ?? [])],
      sourceNames: copySources,
    }
    next.phase = 'copy'
    next.log = [...next.log, `${actor.name}'s ${copySources[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }

  const resumedTriggers = finishDeferredHavocs(next, actor, forced?.deferredHavocs ?? [])
  ctx.pendingTriggers = [
    ...(forced?.pendingTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), forcedChoices)
}

/** Resolves the physical original after its separately targeted virtual copy. */
export function playCardCopy(
  state: CombatState,
  playerId: string,
  context: PlayContext = { enemyUid: null, playerId: null },
): CombatState {
  if ((state.pendingTriggers?.length ?? 0) > 0) return state
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead) return state
  if (player.cardPlayLocked) return skipCardCopy(state, playerId, 'was skipped by Conclude')
  if (reachedTimeWarpLimit(state, player)) return skipCardCopy(state, playerId, 'was skipped by Time Warp')
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  const sourceName = pending.sourceNames[0]
  if ((sourceName === 'Double Tap' && def.type !== 'attack') ||
    (sourceName === 'Blasphemy' && def.type !== 'attack') ||
    (sourceName === 'Omniscience' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Weave' && def.id !== 'weave') ||
    (sourceName === 'Echo Form' && def.type !== 'attack' && def.type !== 'skill') ||
    (sourceName === 'Burst' && def.type !== 'skill') ||
    (sourceName === 'Doppelganger' && def.type !== 'attack' && def.type !== 'skill')) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
    if (!cardModeIsAvailable(def, state, player, context.mode!)) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  if (!cardResolutionChoicesAreValid(state, player, def, effects, context, pending.energySpent)) return state

  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)!
  addPresentationEvent(next, {
    kind: 'card',
    actorId: actor.id,
    sourceId: def.id,
    upgraded: copy.card.upgraded,
    copied: copy.virtualOnly === true || copy.sourceNames.length > 1,
    energy: copy.energySpent,
    ...(context.mode === undefined ? {} : { mode: context.mode }),
    ...presentationTargets(next, actor.id,
      presentationEnemyScope(def, effects, actor, !context.evokeEnemyUids, pending.energySpent),
      def.supportTarget ?? 'self', presentationCardContext(def, effects, context)),
  })
  if ((copy.queuedCopySources?.length ?? 0) > 0) {
    consumeCopySource(actor, copy.queuedCopySources!)
    copy.queuedCopySources = []
  }
  if (copy.consumeFreeCard) actor.freeCardsThisTurn = Math.max(0, (actor.freeCardsThisTurn ?? 0) - 1)
  if (copy.consumeFreeAttack) actor.freeAttacksThisTurn = Math.max(0, (actor.freeAttacksThisTurn ?? 0) - 1)
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  if (def.type === 'attack' || def.type === 'skill') {
    next.playedCardsThisTurn = [
      ...(next.playedCardsThisTurn ?? []),
      {
        playerId: actor.id,
        card: forgetRetain(copy.card),
        copied: copy.virtualOnly === true || copy.sourceNames.length > 1,
      },
    ]
  }
  const ctx = resolutionContext(
    context, def, copy.card, copy.energySpent,
    copy.virtualOnly === true || copy.sourceNames.length > 1,
  )
  next.log = [...next.log, `${actor.name} played ${def.name}`]

  let remainingEffects: Effect[] | undefined
  for (const [index, effect] of effects.entries()) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', ctx)
    if (invalidPlayChoice(ctx)) return state
    if (cardResolutionIsOver(next, ctx, actor)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
    if (ctx.doppelgangerCopy) {
      remainingEffects = effects.slice(index + 1)
      break
    }
  }
  // The forced child is part of a copied Havoc. Suspend this copy until that
  // child finishes, just as the copied Havoc does above.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...copy.deferredHavocs,
      { card: { ...copy.card }, exhaust: copy.forcedExhaust, virtualOnly: copy.virtualOnly,
        ...(copy.sourceNames.length > 1 ? {
          copySourceNames: copy.sourceNames.slice(1) as CopySource[],
          copyResumePhase: copy.resumePhase,
        } : {}) },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [...(ctx.pendingTriggers ?? [])]
    if (copy.deferredTriggers?.length) {
      next.startTurnProgress.forcedCard.pendingTriggers.push(...copy.deferredTriggers)
    }
    if (copy.forcedChoices) {
      next.startTurnProgress.choices = copy.forcedChoices.map((choice) => ({ ...choice }))
    }
    delete next.pendingCardCopy
    next.phase = copy.resumePhase
    return settle(next)
  }
  if (invalidPlayChoice(ctx)) return state

  resolvePendingEnemyReactions(next, actor, ctx)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }

  for (const pendingDiscard of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pendingDiscard.playerId)
    if (owner) resolveDiscardReactions(next, owner, pendingDiscard.cards)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  const finalCopy = copy.sourceNames.length === 1
  if (ctx.doppelgangerCopy) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    next.pendingCardCopy = {
      playerId: actor.id,
      card: ctx.doppelgangerCopy,
      energySpent: copy.energySpent,
      resumePhase: copy.resumePhase,
      forcedExhaust: ctx.queuedCopyForcedExhaust === true,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: [
        ...copy.deferredHavocs,
        { card: forgetRetain(copy.card), exhaust: def.exhaust === true || copy.forcedExhaust || corrupt,
          virtualOnly: copy.virtualOnly,
          remainingEffects,
          ...(copy.sourceNames.length > 1 ? {
            copySourceNames: copy.sourceNames.slice(1) as CopySource[],
            copyResumePhase: copy.resumePhase,
          } : {}) },
      ],
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      sourceNames: ctx.queuedCopySourceNames ?? (ctx.queuedCopyTwice
        ? [ctx.queuedCopySource ?? 'Doppelganger', ctx.queuedCopySource ?? 'Doppelganger']
        : [ctx.queuedCopySource ?? 'Doppelganger']),
      virtualOnly: ctx.queuedCopyVirtualOnly ?? true,
      queuedWeaves: ctx.queuedWeaves,
      queuedCopySources: ctx.queuedCopySources,
      consumeFreeCard: ctx.consumeQueuedFreeCard,
      consumeFreeAttack: ctx.consumeQueuedFreeAttack,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  if (finalCopy && !copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const ownerId of ctx.pendingPoisonTriggers ?? []) {
    const owner = findPlayer(next, ownerId)
    if (owner) fireTriggers(next, { kind: 'onApplyPoison' }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  for (const pendingToken of ctx.pendingEnemyTokenTriggers ?? []) {
    const owner = findPlayer(next, pendingToken.playerId)
    if (owner) fireTriggers(next, { kind: 'onPutEnemyToken', enemyUid: pendingToken.enemyUid }, owner)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }

  if (def.type === 'attack' && !ctx.sourceAttackCounted) {
    actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  }
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, copy.card.uid)
  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) {
    delete next.pendingCardCopy
    return finishForcedCardPlay(settle(next), copy.forcedChoices)
  }
  if (!finalCopy) {
    copy.sourceNames = copy.sourceNames.slice(1)
    next.log = [...next.log, `${actor.name}'s ${copy.sourceNames[0]} copy finished; ${def.name} remains to resolve`]
    releasePendingTriggers(next, ctx)
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  if (copy.queuedWeaves?.length) {
    const woven = copy.queuedWeaves[0]!
    const queuedWeaves = copy.queuedWeaves.slice(1)
    const weave = faceOf(cardDef(woven.defId), woven.upgraded)
    const queuedCopySources = copySourcesFor(weave, actor)
    const sourceNames = queuedCopySources.length > 0
      ? [...queuedCopySources, queuedCopySources.at(-1)!]
      : ['Weave' as const]
    next.pendingCardCopy = {
      playerId: actor.id,
      card: { ...woven, scryDamageBonus: weave.scryPlayBonus },
      energySpent: 0,
      resumePhase: copy.resumePhase,
      forcedExhaust: false,
      forcedChoices: copy.forcedChoices,
      deferredHavocs: copy.deferredHavocs,
      deferredTriggers: [...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? [])],
      sourceNames,
      queuedWeaves,
      queuedCopySources,
      consumeFreeCard: (actor.freeCardsThisTurn ?? 0) > 0,
      consumeFreeAttack: (actor.freeAttacksThisTurn ?? 0) > 0,
    }
    next.phase = 'copy'
    const settled = settle(next)
    return actor.cardPlayLocked || reachedTimeWarpLimit(settled, actor)
      ? skipCardCopy(settled, actor.id, actor.cardPlayLocked ? 'was skipped by Conclude' : 'was skipped by Time Warp')
      : settled
  }
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  ctx.pendingTriggers = [
    ...(copy.deferredTriggers ?? []), ...(ctx.pendingTriggers ?? []), ...resumedTriggers,
  ]
  releasePendingTriggers(next, ctx)
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

function skipCardCopy(state: CombatState, playerId: string, reason: string): CombatState {
  const pending = state.pendingCardCopy
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId) return state
  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)
  if (!actor) return state
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  const def = faceOf(cardDef(copy.card.defId), copy.card.upgraded)
  const ctx = resolutionContext({ enemyUid: null, playerId }, def, copy.card, copy.energySpent)
  if (!copy.virtualOnly) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const woven of copy.queuedWeaves ?? []) actor.discard.push(forgetRetain(woven))
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
  }
  next.log = [...next.log, copy.virtualOnly
    ? `${actor.name}'s ${copy.sourceNames[0]} copy of ${def.name} ${reason}`
    : `${actor.name}'s original ${def.name} ${reason}`]
  const resumedTriggers = finishDeferredHavocs(next, actor, copy.deferredHavocs)
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(copy.deferredTriggers ?? []), ...resumedTriggers],
  })
  return finishCardCopy(settleForbiddenPendingCopy(next, actor), copy.forcedChoices)
}

/** Releases a disconnected owner without letting the rest of the party deadlock. */
export function abandonCardCopy(state: CombatState, playerId: string): CombatState {
  return skipCardCopy(state, playerId, 'was skipped after disconnecting')
}

/** Privately previews the original card's post-copy draw or Scry choice. */
export function previewCardCopyChoice(state: CombatState, playerId: string): CardChoicePreview | null {
  const pending = state.pendingCardCopy
  const player = findPlayer(state, playerId)
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId || !player || player.dead ||
    player.cardPlayLocked || reachedTimeWarpLimit(state, player)) return null
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  if (!cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw' || effect.kind === 'searchDrawAndPlayTwice') {
      return { kind: 'search', cards: effect.kind === 'searchDraw'
        ? actor.draw
        : omniscienceEligibleCards(preview, actor) }
    } else if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor, undefined, {
        enemyUid: null, playerId, energySpent: pending.energySpent,
      }), [])
      drew = true
    } else if (effect.kind === 'scry') {
      return { kind: 'scry', cards: actor.draw.slice(0, effect.amount) }
    } else if (drew && effect.kind === 'discard') {
      return { kind: 'discard', cards: actor.hand }
    } else if (drew && effect.kind === 'topdeck') {
      return { kind: 'topdeck', cards: actor.hand }
    }
  }
  return null
}

export type PowerContext = { enemyUid?: string | null; enemyRow?: number | null }

export const powerAbilityKey = (playerId: string, powerUid: string): string =>
  `${playerId}/power:${powerUid}`

export function powerAbilityUsed(state: CombatState, playerId: string, powerUid: string): boolean {
  return state.powerTriggersUsedThisTurn.includes(powerAbilityKey(playerId, powerUid))
}

/** Activates a printed once-per-turn Power during the shared Player Turn. */
export function activatePower(
  state: CombatState,
  playerId: string,
  powerUid: string,
  context: PowerContext = {},
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, playerId)
  const held = player?.powers.find((power) => power.uid === powerUid)
  if (!player || player.dead || !held) return state
  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (!def.activeAbility || !def.oncePerTurn || powerAbilityUsed(state, playerId, powerUid)) return state
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if (cardNeedsEnemy(def, player, true, undefined, true) &&
    resolveEnemyTargets(state, def.target ?? 'enemy', context.enemyUid ?? null).length === 0) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  next.powerTriggersUsedThisTurn.push(powerAbilityKey(playerId, powerUid))
  const playContext: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId,
    sourcePowerUid: powerUid,
  }
  for (const effect of def.effects) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', playContext,
      `${actor.name}'s ${def.name}`)
    if (combatIsOver(next)) return settle(next)
  }
  return settle(next)
}

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
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state))
}

function resolveDueSummons(next: CombatState, timing: 'startOfTurn' | 'endOfTurn'): void {
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
      const summoned: Enemy = {
        uid: `${summon.sourceUid}-summon-${next.turn}-${summon.row}-${index}`,
        defId, row: summon.row, isBoss: summon.isBoss ?? false, ascension,
        hp, maxHp: hp, block: 0,
        strength: (summon.strengthDefId === undefined || summon.strengthDefId === name ? summon.strength ?? 0 : 0) +
          (summon.strengthPerPower
            ? Math.max(0, ...next.players.filter((player) => !player.dead).map((player) => player.powers.length))
            : 0),
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

function finishStartTurnDraw(next: CombatState, drewFrom: number, roll: boolean): void {
  if (roll) next.die = nextInt(next.rng, 6) + 1
  if (roll) for (const player of next.players) {
    const snecko = next.enemies.find((enemy) => !enemy.dead && enemy.row === player.row &&
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'confusion'))
    const confusion = snecko && enemyAbilities(enemyDef(snecko.defId, snecko.ascension))
      .find((ability) => ability.kind === 'confusion')
    if (confusion?.kind === 'confusion') player.nextCardCost = confusion.byRoll[next.die] ?? null
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

function continueStartTurnDraw(next: CombatState, drewFrom: number): CombatState {
  for (const player of next.players) {
    if (player.dead) continue
    for (const relic of player.relics) {
      if (['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(relic.defId)) relic.spent = false
    }
    drawInto(next, player, 5)
  }

  flushPendingTriggers(next)
  if (combatIsOver(next)) {
    finishStartTurnDraw(next, drewFrom, false)
    return settle(next)
  }
  if (next.pendingTriggers.length > 0) {
    next.startTurnProgress = { choices: [], rollPending: { drewFrom } }
    return next
  }
  // One roll per round; every die effect this round reads this value. It comes
  // after every Draw-step reaction, so the die cannot inform those choices.
  finishStartTurnDraw(next, drewFrom, true)
  return next
}

/** Start of Turn: reset, draw 5, then roll the shared die (p.12). Mutates `next`. */
function beginPlayerTurn(next: CombatState): CombatState {
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
  next.discardedThisTurn = []
  next.stanceChangedThisTurn = []
  next.powerTriggersUsedThisTurn = []
  next.playedCardsThisTurn = []
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
    const keepBlock = player.powers.some((power) => cardDef(power.defId).retainBlock) || player.calipersArmed
    if (!keepBlock) player.block = 0
    player.calipersArmed = false
    player.drawLocked = false
    player.hpLostThisRound = 0
    player.hpLossLimitThisRound = undefined
    player.freeCardsThisTurn = 0
    player.freeAttacksThisTurn = 0
    player.cardPlayLocked = false
    player.doubledAttacksThisTurn = 0
    player.tripledAttacksThisTurn = 0
    player.doubledCardsThisTurn = 0
    player.doubledSkillsThisTurn = 0
    player.retainCardsThisTurn = 0
    player.cardsPlayedThisTurn = 0
    player.powerPlayedThisTurn = false
    player.damageDealtZeroThisTurn = false
    player.attacksPlayedThisTurn = 0
    for (const pile of ['hand', 'draw', 'discard', 'exhaust', 'powers'] as const) {
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
      choices: [], beforeDraw: { drewFrom, sources: beforeDraw, ordered: beforeDraw.length === 1 },
    }
    return next
  }
  return continueStartTurnDraw(next, drewFrom)
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

function continueBeforeDraw(state: CombatState): CombatState {
  const progress = state.startTurnProgress?.beforeDraw
  if (state.pendingCardCopy) return state
  if (!progress || progress.sources.length > 0 || state.pendingTriggers.length > 0) return settle(state)
  state.startTurnProgress = undefined
  return finishPreparedStartTurnWithChoices(continueStartTurnDraw(state, progress.drewFrom))
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

type StartTurnSource = {
  ability: Omit<StartTurnAbility, 'overflowShivs'>
  source?: TriggerSource
  enemyUid?: string
  enemyBlock?: number
  enemyAction?: EnemyAction
  facingPlayerId?: string
}

function triggerTargets(state: CombatState, player: Player, source: TriggerSource) {
  return (source.scope === 'enemy' || source.scope === 'row') &&
    source.effects.some((effect) => reachesEnemy(effect, player))
    ? livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) }))
    : undefined
}

const loopOrbTarget = (slot: number, enemyUid?: string): string => `${slot}:${enemyUid ?? ''}`

function parseLoopOrbTarget(value: string | undefined): { slot: number; enemyUid: string | null } | undefined {
  if (value === undefined) return undefined
  const colon = value.indexOf(':')
  const slot = Number(value.slice(0, colon))
  if (colon < 1 || !Number.isInteger(slot) || slot < 0) return undefined
  return { slot, enemyUid: value.slice(colon + 1) || null }
}

function loopOrbTargets(state: CombatState, player: Player): EndTurnAbility['targets'] {
  const targets = player.orbs.flatMap((orb, slot) => orb === 'frost'
    ? [{ uid: loopOrbTarget(slot), label: `Frost Orb ${slot + 1}` }]
    : orb === 'lightning'
      ? lightningTargetOptions(state, player).map((target) => ({
        uid: loopOrbTarget(slot, target.uid),
        label: `Lightning Orb ${slot + 1} → ${target.label}`,
      }))
      : [])
  return targets.length > 0 ? targets : undefined
}

function startTurnSources(state: CombatState): StartTurnSource[] {
  if (state.phase !== 'start' || state.startTurnProgress?.beforeDraw || state.startTurnProgress?.rollPending ||
    state.startTurnProgress?.discard) return []
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
  if (owner) for (const enemy of livingEnemies(state)) {
    const def = enemyDef(enemy.defId, enemy.ascension)
    const amount = state.turn === 1 ? def.startingBlock ?? 0 : 0
    if (amount > 0) enemySources.push({
      enemyUid: enemy.uid, enemyBlock: amount,
      ability: { id: `enemy:${enemy.uid}/starting-block`, playerId: owner.id,
        label: `${enemyLabel(state.enemies, enemy)} — ${amount} Block` },
    })
  }
  const regrow = owner && state.enemies.some((enemy) => enemy.dead && enemy.defId.startsWith('darkling')) &&
    livingEnemies(state).find((enemy) =>
      enemyAbilities(enemyDef(enemy.defId, enemy.ascension)).some((ability) => ability.kind === 'regrow'))
  if (owner && regrow) enemySources.push({
    enemyUid: regrow.uid, enemyAction: { kind: 'reviveAll', group: 'darkling' },
    ability: { id: 'enemy:darkling/regrow', playerId: owner.id,
      label: `${enemyLabel(state.enemies, regrow)} — Regrow` },
  })
  return [...playerSources, ...enemySources]
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
          choice?.evokeSlots, choice?.evokeEnemyUids, undefined, choice?.targetPlayerId,
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
    state.startTurnProgress?.discard ||
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

function continueStartTurn(
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
        ? !ability.targets.some((target) => target.uid === choice.enemyUid)
        : choice.enemyUid !== undefined) ||
      (ability.players
        ? !ability.players.some((candidate) => candidate.id === choice.targetPlayerId)
        : choice.targetPlayerId !== undefined) ||
      !validStartTurnShivChoice(next, player, ability.overflowShivs, choice.shivEnemyUids) ||
      !validStartTurnEvokeChoice(next, player, entry.source, choice)) {
      next.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return rollback ?? next
    }
    if (!entry.source) {
      if (entry.facingPlayerId) {
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
      choice.evokeSlots, choice.evokeEnemyUids, undefined, choice.targetPlayerId,
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

function finishForcedCardPlay(
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
  return continueStartTurn(state, choices)
}

function finishCardCopy(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
  const resumed = finishForcedCardPlay(state, choices)
  return resumed.phase === 'start' && resumed.startTurnProgress?.beforeDraw
    ? continueBeforeDraw(resumed)
    : resumed
}

/** Settles a disconnected owner's private forced card and resumes queued abilities. */
export function abandonForcedCard(state: CombatState, playerId: string): CombatState {
  const forced = state.startTurnProgress?.forcedCard
  if ((state.phase !== 'start' && state.phase !== 'player') || forced?.playerId !== playerId ||
    typeof forced.cardUid !== 'string') return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  const card = actor?.hand.find((held) => held.uid === forced.cardUid)
  if (!actor || !card) return state
  const choices = [...(next.startTurnProgress?.choices ?? [])]
  next.startTurnProgress = undefined
  if (forced.exhaustNonPower && faceOf(cardDef(card.defId), card.upgraded).type !== 'power') {
    actor.hand = actor.hand.filter((held) => held.uid !== card.uid)
    exhaustCards(next, actor, [card])
  } else {
    discardByCardEffect(next, actor, [card])
  }
  next.log = [...next.log, `${actor.name}'s ${cardDef(forced.sourceCardId ?? 'mayhem').name} card was settled after disconnecting`]
  const resumedTriggers = finishDeferredHavocs(next, actor, forced.deferredHavocs ?? [])
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: [...(forced.pendingTriggers ?? []), ...resumedTriggers],
  })
  return finishForcedCardPlay(settleForbiddenPendingCopy(next, actor), choices)
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
 * enemy: `STALE_END_TURN_ORDER` says as much on the other side of the turn —
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
  if (abilities.some((ability) => ability.overflowShivs > 0 || (ability.targets?.length ?? 0) > 1 ||
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
      abilities.push({
        id: `orb:${slot}`,
        label: `Lightning Orb ${slot + 1}`,
        targets: lightningTargetOptions(state, player),
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

/** Retargets still-unresolved single-enemy abilities after a mandatory reaction kills their target. */
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
    const fallback = ability.targets[0]
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
  rollback?: CombatState,
): CombatState {
  const next = state
  for (let index = 0; index < order.length; index++) {
    const choice = order[index]!
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
          if (rollback) return rollback
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
          if (rollback) return rollback
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
 * Shown when an end-of-turn order cannot resolve against a list that still
 * matches the battle — solo and online alike, so the two paths cannot drift into
 * different recovery advice. The cause is always an ability aimed at something
 * an earlier ability kills, so the fix is re-aiming it, not picking a target
 * that looks alive right now.
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
  return continueEndPlayerTurn(next, order, state)
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

/**
 * The Enemy Turn (p.13): clear enemy Block, act from the highest row downward
 * (left to right within a row, bosses last), then advance every cube.
 *
 * Enemies hit the player in their own row; an area-of-effect action hits every
 * player. Block and Strength always land on the enemy itself, never on a player.
 */
export function enemyTurn(state: CombatState): CombatState {
  if (state.phase !== 'enemy' || (state.pendingTriggers?.length ?? 0) > 0) return state
  const next = clone(state)

  // Enemy Block is cleared at the start of the ENEMY turn, unlike player Block.
  for (const enemy of next.enemies) {
    if (!enemyDef(enemy.defId, enemy.ascension).retainsBlock) enemy.block = 0
  }

  for (const enemy of enemyActingOrder(next)) {
    if (enemy.dead) continue
    // p.13 normally ends combat immediately when one player dies, so enemies
    // still queued behind the killing blow do not act. The Last Stand's Boss
    // exception keeps this loop going while any player survives.
    if (combatIsOver(next)) break
    for (const action of actionsForEnemy(enemy, next.die)) {
      applyEnemyAction(next, enemy, action)
      if (combatIsOver(next)) break
    }
  }

  for (const enemy of next.enemies) {
    if (enemy.dead) continue
    const def = enemyDef(enemy.defId, enemy.ascension)
    const rally = enemyAbilities(def).find((ability) => ability.kind === 'rally')
    const noSummons = rally?.kind === 'rally' && !next.enemies.some((candidate) => !candidate.dead &&
      (candidate.defId === rally.summonDefId || candidate.defId.startsWith(`${rally.summonDefId}_`)))
    if (def.pattern.kind === 'cube' && def.pattern.slots[enemy.actionIndex]?.once) {
      enemy.spentOnceSlots = [...new Set([...(enemy.spentOnceSlots ?? []), enemy.actionIndex])]
    }
    let nextIndex = noSummons && enemy.actionIndex === 1 ? 0 : advanceCube(def, enemy.actionIndex)
    if (def.pattern.kind === 'cube') for (let skipped = 0; skipped < def.pattern.slots.length; skipped++) {
      if (!def.pattern.slots[nextIndex]?.once || !enemy.spentOnceSlots?.includes(nextIndex)) break
      nextIndex = advanceCube(def, nextIndex)
    }
    enemy.actionIndex = nextIndex
  }

  // The round is over. The next Start of Turn is its own step (p.12) rather
  // than something that happens invisibly: with three or four players, the
  // board must hold still long enough to read what the enemies just did before
  // every hand is swept up and redealt.
  next.phase = 'roundEnd'
  return settle(next)
}

/** Highest row first, then left to right, with bosses and "acts last" at the end. */
export function enemyActingOrder(state: CombatState): Enemy[] {
  const order = state.enemies.filter((enemy) => !enemy.dead)
  const isLast = (enemy: Enemy) => enemy.isBoss ||
    enemy.actsLast === true ||
    enemyDef(enemy.defId, enemy.ascension).actsLast === true ||
    actionsForEnemy(enemy, state.die).some((action) => action.kind === 'actsLast')
  return [...order].sort((a, b) => {
    if (isLast(a) !== isLast(b)) return isLast(a) ? 1 : -1
    if (a.row !== b.row) return b.row - a.row
    return state.enemies.indexOf(a) - state.enemies.indexOf(b)
  })
}

function playersInRowOf(state: CombatState, enemy: Enemy): Player[] {
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

function applyEnemyAction(state: CombatState, enemy: Enemy, action: EnemyAction): void {
  const living = state.players.filter((player) => !player.dead)
  const name = enemyLabel(state.enemies, enemy)

  switch (action.kind) {
    case 'attack':
    case 'attackSequence': {
      const mods = attackerModsOfEnemy(enemy)
      const curiosity = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .some((ability) => ability.kind === 'curiosity')
      const hits = action.kind === 'attackSequence'
        ? action.hits
        : Array.from({ length: action.times ?? 1 }, () => ({ amount: action.amount, aoe: action.aoe }))
      const snapshots = new Map<Player, {
        hp: number
        block: number
        vulnerable: number
        lost: number
        attempted: number
      }>()
      let attacked = false
      attack: for (const hit of hits) {
        const targets = hit.aoe ? living
          : action.kind === 'attack' && action.facing
            ? living.filter((player) => player.facingEnemyUid === enemy.uid)
            : playersInRowOf(state, enemy)
        attacked ||= targets.length > 0
        for (const target of targets) {
          if (target.dead) continue
          const before = snapshots.get(target) ?? {
            hp: target.hp, block: target.block, vulnerable: target.vulnerable, lost: 0, attempted: 0,
          }
          snapshots.set(target, before)
          const amount = hitDamage(
            hit.amount + (curiosity ? target.powers.length : 0), mods, { vulnerable: before.vulnerable },
          )
          before.attempted += amount
          before.lost += damagePlayer(state, target, amount).hpLost
          if (target.dead && combatIsOver(state)) break attack
        }
      }
      for (const [target, before] of snapshots) {
        if (before.vulnerable > 0) {
          target.vulnerable = before.vulnerable - 1
          state.log = [...state.log, `${target.name} spends a Vulnerable`]
        }
        const blocked = before.block - target.block
        state.log = [
          ...state.log,
          before.lost > 0
            ? `${name} hit ${target.name} for ${before.lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
            : blocked >= before.attempted && before.attempted > 0
              ? `${target.name} blocked ${name} completely (${blocked} spent)`
              : `${name} did no damage to ${target.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`,
        ]
        if (target.dead) {
          state.log = [...state.log, `${target.name} has fallen`]
          // Ordinarily the rest of the sweep never lands. The Last Stand is
          // the exception: surviving targets still finish this same action.
          if (combatIsOver(state)) break
        }
        const painful = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
          .find((ability) => ability.kind === 'painfulStabs')
        if (before.lost > 0 && painful?.kind === 'painfulStabs') {
          const gained = addDaze(state, target, painful.daze, 'draw', enemy.uid)
          if (gained > 0) state.log = [...state.log, `${name}'s Painful Stabs gave ${target.name} ${gained} Daze`]
        }
      }
      // One Weak token comes off after the whole action, not per hit — and only
      // if the action actually attacked something. An enemy swinging at an
      // empty row has not attacked (p.24), same rule as the player side.
      if (attacked && enemy.weak > 0) {
        enemy.weak -= 1
        state.log = [...state.log, `${name} spends a Weak`]
      }
      return
    }
    case 'block': {
      // The amount actually gained, not the amount printed: at the cap the
      // enemy gains nothing and the log should not claim otherwise.
      const before = enemy.block
      enemy.block = gainBlock(enemy.block, action.amount * (action.perPlayer ? state.players.length : 1))
      if (enemy.block > before) {
        state.log = [...state.log, `${name} gained ${enemy.block - before} Block`]
      }
      return
    }
    case 'blockAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.block
        target.block = gainBlock(target.block, action.amount)
        changed ||= target.block > before
      }
      if (changed) state.log = [...state.log, `${name} bolstered all enemies`]
      return
    }
    case 'strengthenAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.strength
        target.strength = gainStrength(target.strength, action.amount)
        changed ||= target.strength > before
      }
      if (changed) state.log = [...state.log, `${name} strengthened all enemies`]
      return
    }
    case 'healAllEnemies': {
      let changed = false
      for (const target of state.enemies) if (!target.dead) {
        const before = target.hp
        target.hp = Math.min(target.maxHp, target.hp + action.amount)
        changed ||= target.hp > before
      }
      if (changed) state.log = [...state.log, `${name} healed all enemies`]
      return
    }
    case 'healSelf': {
      const before = enemy.hp
      enemy.hp = Math.min(enemy.maxHp, enemy.hp + action.amount)
      if (enemy.hp > before) state.log = [...state.log, `${name} healed ${enemy.hp - before} HP`]
      return
    }
    case 'blockNamed': {
      const target = state.enemies.find((candidate) => !candidate.dead &&
        (candidate.row === enemy.row || candidate.isBoss) &&
        (candidate.defId === action.defId || candidate.defId.startsWith(`${action.defId}_`)))
      if (target) {
        const before = target.block
        target.block = gainBlock(target.block, action.amount)
        if (target.block > before) state.log = [...state.log,
          `${name} gave ${enemyLabel(state.enemies, target)} ${target.block - before} Block`]
      }
      return
    }
    case 'clearSelfDebuffs':
      enemy.weak = enemy.vulnerable = 0
      state.log = [...state.log, `${name} removed its debuffs`]
      return
    case 'reviveAll': {
      const count = reviveAll(state, action.group)
      state.log = [...state.log, `${name} revived ${count} ${action.group}${count === 1 ? '' : 's'}`]
      return
    }
    case 'gainStrength': {
      const before = enemy.strength
      enemy.strength = gainStrength(enemy.strength, action.amount)
      if (enemy.strength > before) {
        state.log = [...state.log, `${name} gained ${enemy.strength - before} Strength`]
      }
      return
    }
    case 'applyWeak': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const before = target.weak
        target.weak = gainWeak(target.weak, action.amount)
        if (target.weak > before) state.log = [...state.log, `${name} weakened ${target.name}`]
      }
      return
    }
    case 'applyVulnerable': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, action.amount)
        if (target.vulnerable > before) {
          state.log = [...state.log, `${name} left ${target.name} vulnerable`]
        }
      }
      return
    }
    case 'daze': {
      // Daze goes on TOP of the draw pile, so it is the very next card drawn.
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const gained = addDaze(state, target, action.amount, 'draw', enemy.uid)
        if (gained > 0) {
          state.log = [...state.log, `${name} slipped ${gained === 1 ? 'a Daze' : `${gained} Daze`} into ${target.name}'s deck`]
        }
      }
      return
    }
    case 'status':
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        const gained = addStatus(state, target, action.card, action.amount, enemy.uid)
        if (gained > 0) state.log = [...state.log, `${name} gave ${target.name} ${gained} ${action.card}`]
      }
      return
    case 'loseGold':
      for (const target of playersInRowOf(state, enemy)) {
        const lost = Math.min(target.gold, action.amount)
        target.gold -= lost
        state.log = [...state.log, `${target.name} lost ${lost} gold to ${name}`]
      }
      return
    case 'leave':
      enemy.dead = true
      state.log = [...state.log, `${name} left combat`]
      return
    case 'die':
      enemy.hp = 0
      enemy.dead = true
      state.log = [...state.log, `${name} died`]
      triggerEnemyDeath(state, enemy)
      return
    case 'addAbilityCube': {
      const tracked = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'thorns' || ability.kind === 'beatOfDeath')
      if (tracked?.kind !== 'thorns' && tracked?.kind !== 'beatOfDeath') return
      const before = enemy.abilityCubes ?? 0
      enemy.abilityCubes = Math.min(tracked.maxCubes, before + action.amount)
      if (enemy.abilityCubes > before) state.log = [...state.log,
        `${name} added ${enemy.abilityCubes - before} ability cube`]
      return
    }
    case 'transform':
      enemy.defId = action.defId
      enemy.actionIndex = -1
      state.log = [...state.log, `${name} transforms`]
      return
    case 'guardianModeShift':
      if (enemy.block > 0) {
        enemy.block = 0
        applyEnemyAction(state, enemy, { kind: 'attack', amount: action.amount })
      } else {
        enemy.pendingDefId = 'guardian_defensive'
        state.log = [...state.log, `${name} will enter Defensive Mode at the start of the next turn`]
      }
      return
    case 'removeInvincible':
      enemy.abilityUsed = true
      state.log = [...state.log, `${name}'s Invincible is removed`]
      return
    case 'shuffleStatus':
      for (const target of living) {
        const gained = addStatus(state, target, action.card, action.amount, enemy.uid)
        if (gained === 0) continue
        target.draw = shuffle(state.rng, [...target.draw, ...target.discard])
        target.discard = []
        state.log = [...state.log, `${name} shuffled ${gained} ${action.card} into ${target.name}'s deck`]
      }
      return
    case 'summon':
      state.pendingSummons.push({
        sourceUid: enemy.uid, row: enemy.row, defIds: action.defIds, turn: state.turn + 1,
      })
      state.log = [...state.log, `${name} will summon ${action.defIds.map((id) => enemyDef(id).name).join(', ')}`]
      return
    case 'summonUntil': {
      let count = 0
      for (const row of new Set(state.players.filter((player) => !player.dead).map((player) => player.row))) {
        const present = state.enemies.filter((candidate) => !candidate.dead && candidate.row === row &&
          (candidate.defId === action.defId || candidate.defId.startsWith(`${action.defId}_`))).length
        const queued = state.pendingSummons.filter((summon) => summon.row === row).reduce((total, summon) =>
          total + summon.defIds.filter((id) => id === action.defId).length, 0)
        const needed = Math.max(0, action.perPlayer - present - queued)
        if (needed === 0) continue
        state.pendingSummons.push({
          sourceUid: enemy.uid, row, defIds: Array(needed).fill(action.defId), turn: state.turn + 1,
        })
        count += needed
      }
      state.log = [...state.log, `${name} will summon ${count} ${enemyDef(action.defId).name}${count === 1 ? '' : 's'}`]
      return
    }
    case 'actsLast':
    case 'idle':
      return
  }
}


/**
 * Channels an orb into any OPEN slot. If every slot is full, an orb of the
 * player's choice is evoked first and the new one takes its place (p.16).
 * Running out of orb cubes is not modelled: the slots are the limit here.
 */
function channelOrb(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  context: PlayContext,
): boolean {
  if (combatIsOver(state)) return false
  let open = actor.orbs.indexOf(null)
  // A full set forces an evoke to make room (p.16). Unsaid, the evoke's line
  // appeared with nothing to explain why an orb had vanished.
  if (open < 0) {
    state.log = [...state.log, `${actor.name} has no free orb slot, and must evoke to make room`]
    evokeOrb(state, actor, context)
    if (combatIsOver(state)) return false
    open = actor.orbs.indexOf(null)
    if (open < 0) return false
  }
  actor.orbs[open] = orb
  addPresentationEvent(state, {
    kind: 'orb', orb, actorId: actor.id,
    sourceId: context.presentationSourceId ?? 'orb-channel',
    enemyIds: [], playerIds: [],
  })
  return true
}

function applyOrbEvokeEffect(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  chosenTarget: string | null | undefined,
  sourceCardId?: string,
  pendingTriggers?: PendingTrigger[],
): boolean {
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, chosenTarget, sourceCardId)
    if (!targets) return false
    for (const target of targets) {
      damageEnemyLogged(state, target, actor.damageDealtZeroThisTurn ? 0 : 2 + (actor.orbEvokeBonus ?? 0), `${actor.name}'s Lightning orb`)
    }
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1 + (actor.orbEvokeBonus ?? 0), pendingTriggers)
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  } else {
    const target = livingEnemies(state).find((enemy) => enemy.uid === chosenTarget)
    if (!target) return false
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    damageEnemyLogged(
      state,
      target,
      actor.damageDealtZeroThisTurn ? 0 :
        3 + actor.powers.length + (actor.orbEvokeBonus ?? 0) + (actor.darkOrbEvokeBonus ?? 0),
      `${actor.name}'s Dark orb`,
    )
  }
  return true
}

/**
 * Evokes one orb and applies its effect.
 *
 * The board game lets you evoke ANY orb — there is no front slot and no
 * rotation (p.16) — and the atomic context carries one slot and, where needed,
 * one enemy for each evoke.
 */
function evokeOrb(state: CombatState, actor: Player, context: PlayContext, times = 1): OrbType | null {
  // The slot has to be a real array INDEX, not any property key. These values
  // arrive as JSON from a client, and `orbs['length']` was truthy — it evoked
  // a non-existent Dark orb for free damage and then assigned null to
  // `length`, truncating the array to zero slots for the rest of the combat.
  // `orbs['__proto__']` was worse: it nulled the prototype and the next call
  // threw straight out of the room layer.
  const index = context.evokeIndex ?? 0
  const chosen = context.evokeSlots?.[index]
  const slot = chosen !== undefined && Number.isInteger(chosen) && chosen >= 0 &&
    chosen < actor.orbs.length && actor.orbs[chosen] != null
    ? chosen
    : actor.orbs.findIndex((orb) => orb != null)
  if (slot < 0) return null
  const orb = actor.orbs[slot]
  if (!orb) return null
  actor.orbs[slot] = null
  context.evokeIndex = index + 1

  for (let repeat = 0; repeat < times && !combatIsOver(state); repeat++) {
    const targetIndex = context.evokeTargetIndex ?? 0
    context.evokeTargetIndex = targetIndex + 1
    const fallbackEnemy = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0] ?? livingEnemies(state)[0]
    const chosenTarget = context.evokeEnemyUids?.[targetIndex] ??
      (orb === 'lightning' && lightningTargetsRows(actor, context.sourceCardId) && fallbackEnemy
        ? lightningRowTarget(fallbackEnemy.row)
        : fallbackEnemy?.uid)
    if (!applyOrbEvokeEffect(
      state,
      actor,
      orb,
      chosenTarget,
      context.sourceCardId,
      context.sourceCardId ? context.pendingTriggers : undefined,
    ) &&
      livingEnemies(state).length > 0) context.invalidEvokeTarget = true
  }
  return orb
}

/** Resolves one Orb's end-turn effect; each Orb is separately ordered (p.16). */
function resolveOrbAtEndOfTurn(state: CombatState, actor: Player, slot: number, targetUid?: string): boolean {
  const orb = actor.orbs[slot]
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, targetUid)
    if (!targets) return false
    for (const target of targets) {
      damageEnemyLogged(
        state,
        target,
        actor.damageDealtZeroThisTurn ? 0 :
          1 + (actor.orbEndTurnBonus ?? 0) + (actor.lightningEndTurnBonus ?? 0),
        `${actor.name}'s Lightning orb`,
      )
    }
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1 + (actor.orbEndTurnBonus ?? 0))
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  }
  return true
}


/**
 * Fires every ongoing effect that matches an event: relics first, then Powers
 * in the order they were played.
 *
 * Relics and Powers are the same mechanism — a permanent thing in front of you
 * that reacts — so they share one dispatcher rather than drifting apart.
 *
 * Legacy trigger paths target the first living enemy where needed. The
 * table-facing Start-of-Turn phase supplies its explicit ordered choices.
 */
/**
 * How deep a trigger chain may go. A Power that gains Block whenever it gains
 * Block would otherwise recurse until the stack blew. The board game has no
 * such card, but the engine must not be one data entry away from a hang, and a
 * silent infinite loop is far worse than a chain that stops.
 *
 * Triggers past this depth are DROPPED, silently and deliberately: there is no
 * sensible way to surface it mid-resolution, and a truncated chain is a better
 * failure than a frozen tab. If a real card ever chains deeper than this, the
 * cap is the thing to revisit — a legitimate combo would look like a card
 * quietly under-performing rather than an error. Draw events are exempt: a
 * draw-only chain consumes the finite draw/discard piles, while any cyclic
 * non-draw event it fires still passes through this guard.
 */
export const MAX_TRIGGER_DEPTH = 8
let triggerDepth = 0

function fireTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  const finiteDrawChain = event.kind === 'onDraw'
  if (!finiteDrawChain && triggerDepth >= MAX_TRIGGER_DEPTH) return
  if (!finiteDrawChain) triggerDepth++
  try {
    fireTriggersInner(state, event, only, excludeUid)
  } finally {
    if (!finiteDrawChain) triggerDepth--
  }
}

type TriggerSource = {
  id: string
  presentationSourceId: string
  trigger: Trigger
  effects: Effect[]
  /** Named in the log, so a recurring effect is attributable. */
  name: string
  /** The card's own declared scopes, so a Power hits what it says it hits. */
  scope: TargetScope
  supportScope: TargetScope
  oncePerTurn: boolean
  powerUid?: string
}

function triggerSourceById(player: Player, id: string): TriggerSource | undefined {
  if (id.startsWith('relic:')) {
    const [indexText, abilityText] = id.slice(6).split(':')
    const index = Number(indexText)
    const held = Number.isInteger(index) ? player.relics[index] : undefined
    if (!held) return undefined
    const def = relicDef(held.defId)
    const ability = relicAbilities(def)[Number(abilityText ?? 0)]
    if (!ability) return undefined
    return {
      id,
      presentationSourceId: held.defId,
      trigger: ability.trigger,
      effects: ability.effects,
      name: `${player.name}'s ${def.name}`,
      scope: ability.target ?? 'enemy',
      supportScope: ability.supportTarget ?? 'self',
      oncePerTurn: false,
    }
  }
  if (!id.startsWith('power:')) return undefined
  const held = player.powers.find((power) => power.uid === id.slice(6))
  if (!held) return undefined
  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (!def.trigger) return undefined
  return {
    id,
    presentationSourceId: held.defId,
    trigger: def.trigger,
    effects: def.effects,
    name: `${player.name}'s ${def.name}`,
    scope: def.target ?? 'enemy',
    supportScope: def.supportTarget ?? 'self',
    oncePerTurn: def.oncePerTurn === true,
    powerUid: held.uid,
  }
}

function triggerSources(player: Player, event: TriggerEvent, excludeUid?: string): TriggerSource[] {
  const sources: TriggerSource[] = []
  for (const index of player.relics.keys()) {
    if (player.relics[index]!.defId === 'loaded_die' && player.relics[index]!.spent) continue
    for (const abilityIndex of relicAbilities(relicDef(player.relics[index]!.defId)).keys()) {
      const source = triggerSourceById(player, `relic:${index}:${abilityIndex}`)
      if (source && triggerMatches(source.trigger, event)) sources.push(source)
    }
  }
  for (const held of player.powers) {
    if (held.uid === excludeUid) continue
    const source = triggerSourceById(player, `power:${held.uid}`)
    if (source && triggerMatches(source.trigger, event)) sources.push(source)
  }
  return sources
}

function queuedTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): PendingTrigger[] {
  state.nextTriggerId ??= 0
  return state.players.flatMap((player) => player.dead || (only && player.id !== only.id) ? [] :
    triggerSources(player, event, excludeUid).map((source) => ({
      id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
      enemyUid: event.enemyUid,
    })))
}

function triggerNeedsRowChoice(state: CombatState, player: Player, source: TriggerSource): boolean {
  return source.scope === 'row' && source.effects.some((effect) => reachesEnemy(effect, player)) &&
    combatRows(state).length > 1
}

function triggerNeedsEnemyChoice(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
): boolean {
  return enemyUid === undefined && source.scope === 'enemy' &&
    source.effects.some((effect) => reachesEnemy(effect, player)) && livingEnemies(state).length > 1
}

function triggerNeedsPlayerChoice(state: CombatState, source: TriggerSource): boolean {
  return source.supportScope === 'anyPlayer' &&
    state.players.filter((candidate) => !candidate.dead).length > 1
}

function resolveTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  allowCombatOver = false,
  shivEnemyUids?: readonly (string | null)[],
  enemyUid?: string,
  enemyRow?: number,
  evokeSlots?: readonly number[],
  evokeEnemyUids?: readonly (string | null)[],
  scryDiscardUids?: readonly string[],
  targetPlayerId?: string,
): boolean {
  const useKey = source.powerUid ? powerAbilityKey(player.id, source.powerUid) : `${player.id}/${source.id}`
  if (source.oncePerTurn) {
    const used = (state.powerTriggersUsedThisTurn ??= [])
    if (used.includes(useKey)) return true
    used.push(useKey)
  }
  const loop = source.effects.find((effect) => effect.kind === 'triggerOrbEndTurn')
  if (loop) {
    const slot = evokeSlots?.[0]
    if (slot === undefined) return loopOrbTargets(state, player) === undefined
    const orb = player.orbs[slot]
    const target = evokeEnemyUids?.[0] ?? undefined
    if ((orb !== 'lightning' && orb !== 'frost') || (orb === 'lightning' && !target) ||
      (orb === 'frost' && target !== undefined)) return false
    for (let index = 0; index < loop.amount; index++) {
      if (!resolveOrbAtEndOfTurn(state, player, slot, target)) {
        if (index === 0) return false
        break
      }
      if (combatIsOver(state)) break
    }
    return true
  }
  const target = livingEnemies(state)[0]
  const pendingTriggers: PendingTrigger[] = []
  const context: PlayContext = {
    enemyUid: enemyUid ?? target?.uid ?? null,
    enemyRow,
    playerId: targetPlayerId ?? player.id,
    shivEnemyUids: shivEnemyUids ? [...shivEnemyUids] : undefined,
    shivTargetIndex: 0,
    invalidShivTarget: false,
    evokeSlots: evokeSlots ? [...evokeSlots] : undefined,
    evokeEnemyUids: evokeEnemyUids ? [...evokeEnemyUids] : undefined,
    scryDiscardUids: scryDiscardUids ? [...scryDiscardUids] : undefined,
    evokeIndex: 0,
    invalidEvokeTarget: false,
    sourcePowerUid: source.powerUid,
    presentationSourceId: source.presentationSourceId,
    pendingTriggers,
  }
  const effects = source.name.endsWith("'s Tungsten Rod") && state.players.length === 1
    ? [{ kind: 'block' as const, amount: 3 }]
    : source.effects
  for (const effect of effects) {
    applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
    if (!allowCombatOver && combatIsOver(state)) return true
  }
  const privateDiscard = state.startTurnProgress?.discard
  if (privateDiscard) {
    privateDiscard.pendingTriggers = pendingTriggers
    return !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice
  }
  const forced = state.startTurnProgress?.forcedCard
  if (forced && pendingTriggers.length > 0) {
    forced.pendingTriggers = [...(forced.pendingTriggers ?? []), ...pendingTriggers]
  } else {
    releasePendingTriggers(state, context)
  }
  return !context.invalidShivTarget && !context.invalidEvokeTarget && !context.invalidScryChoice
}

function resolveQueuedTriggerSource(
  state: CombatState,
  player: Player,
  source: TriggerSource,
  enemyUid?: string,
  enemyRow?: number,
  targetPlayerId?: string,
): void {
  if (source.trigger.kind === 'onDraw') {
    resolveTriggerSource(state, player, source, false, undefined, enemyUid, enemyRow,
      undefined, undefined, undefined, targetPlayerId)
    return
  }
  if (triggerDepth >= MAX_TRIGGER_DEPTH) return
  triggerDepth++
  try {
    resolveTriggerSource(state, player, source, false, undefined, enemyUid, enemyRow,
      undefined, undefined, undefined, targetPlayerId)
  } finally {
    triggerDepth--
  }
}

function flushPendingTriggers(state: CombatState): void {
  state.pendingTriggers ??= []
  while (state.pendingTriggers.length > 0 && !combatIsOver(state)) {
    const pending = state.pendingTriggers[0]!
    const player = findPlayer(state, pending.playerId)
    const source = player && triggerSourceById(player, pending.sourceId)
    if (!player || player.dead || !source) {
      state.pendingTriggers.shift()
      continue
    }
    if (triggerNeedsRowChoice(state, player, source) ||
      triggerNeedsEnemyChoice(state, player, source, pending.enemyUid) ||
      triggerNeedsPlayerChoice(state, source)) return
    state.pendingTriggers.shift()
    resolveQueuedTriggerSource(
      state,
      player,
      source,
      pending.enemyUid ?? (source.scope === 'enemy' ? livingEnemies(state)[0]?.uid : undefined),
      source.scope === 'row' ? combatRows(state)[0] : undefined,
    )
  }
}

export type PendingTriggerAbility = {
  id: number
  playerId: string
  label: string
  rows?: { row: number; label: string }[]
  targets?: { uid: string; label: string }[]
  players?: { id: string; label: string }[]
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

function fireTriggersInner(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  const allowCombatOver = event.kind === 'endOfCombat'
  for (const player of state.players) {
    if (!allowCombatOver && combatIsOver(state)) return
    if (player.dead) continue
    if (only && player.id !== only.id) continue

    for (const source of triggerSources(player, event, excludeUid)) {
      if (!allowCombatOver && ((state.pendingTriggers?.length ?? 0) > 0 ||
        triggerNeedsRowChoice(state, player, source) ||
        triggerNeedsEnemyChoice(state, player, source, event.enemyUid) ||
        triggerNeedsPlayerChoice(state, source))) {
        state.pendingTriggers ??= []
        state.nextTriggerId ??= 0
        state.pendingTriggers.push({
          id: state.nextTriggerId++, playerId: player.id, sourceId: source.id,
          enemyUid: event.enemyUid,
        })
        continue
      }
      resolveTriggerSource(
        state,
        player,
        source,
        allowCombatOver,
        undefined,
        event.enemyUid,
        source.scope === 'row' ? combatRows(state)[0] : undefined,
      )
      if (!allowCombatOver && combatIsOver(state)) return
    }
  }
}

/**
 * Whether either ending has already happened.
 *
 * Both are normally immediate (p.13), so anything still queued behind them —
 * another player's orb, their Wrath bite, the next enemy in the order — must
 * not resolve at all. The optional Last Stand rule (p.23) replaces one player
 * death with the whole party dying during a Boss fight.
 */
function lastStandActive(state: CombatState): boolean {
  return state.lastStand && state.enemies.some((enemy) => enemy.isBoss)
}

function combatIsOver(state: CombatState): boolean {
  const lastStand = lastStandActive(state)
  return (state.enemies.every((enemy) => enemy.dead) && state.pendingSummons.length === 0) ||
    (lastStand ? state.players.every((player) => player.dead) : state.players.some((player) => player.dead))
}

function cardResolutionIsOver(state: CombatState, context: PlayContext, actor: Player): boolean {
  return actor.dead || combatIsOver(state) && (context.pendingEnemyDeathUids?.length ?? 0) === 0
}

/** Decides whether the combat has ended, and returns the state either way. */
function settle(state: CombatState): CombatState {
  if (lastStandActive(state) && state.players.every((player) => player.dead)) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'lost'
    return state
  }
  // Outside The Last Stand, victory is tested first. `combatIsOver` normally
  // stops each phase at the moment either ending happens, so this ordering is
  // only a backstop for a state assembled by hand.
  if (state.enemies.every((enemy) => enemy.dead) && state.pendingSummons.length === 0) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'won'
    fireTriggers(state, { kind: 'endOfCombat' })
    return state
  }
  // p.13: ONE death, not a wipe. The optional Last Stand rule on p.23 is the
  // only exception, and applies only to a Boss fight.
  if (!lastStandActive(state) && state.players.some((player) => player.dead)) {
    state.pendingTriggers = []
    delete state.pendingDistilled
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'lost'
    return state
  }
  return state
}

export function createCombat(
  rng: RngState,
  players: Player[],
  enemies: Enemy[],
  combatId = `${rng.seed}:${rng.calls}`,
  potionDeck: string[] = [],
  potionLimit: 2 | 3 = 3,
  summonSupply: SummonSupply = {},
  lastStand = false,
): CombatState {
  return {
    combatId,
    lastStand,
    rng,
    turn: 0,
    die: 1,
    phase: 'player',
    players: players.map((player) => ({
      ...player,
      lostHpThisCombat: false,
      shuffledThisCombat: false,
      hpLostThisRound: 0,
      hpLossLimitThisRound: undefined,
      freeCardsThisTurn: 0,
      freeAttacksThisTurn: 0,
      cardPlayLocked: false,
      doubledAttacksThisTurn: 0,
      tripledAttacksThisTurn: 0,
      doubledCardsThisTurn: 0,
      doubledSkillsThisTurn: 0,
      retainCardsThisTurn: 0,
      cardsPlayedThisTurn: 0,
      powerPlayedThisTurn: false,
      attacksPlayedThisTurn: 0,
      wrathAttackDamageBonus: 0,
      shivDamageBonus: 0,
      cardBlockBonus: 0,
      hitPoison: 0,
      starterStrikeDamageBonus: player.relics.some((relic) => relic.defId === 'strike_dummy') ? 1 : 0,
      clawCubesGainedThisCombat: 0,
      starterDefendBlockBonus: 0,
      akabekoAttacks: 0,
      darkOrbEvokeBonus: 0,
      lightningEndTurnBonus: 0,
    })),
    enemies: enemies.map((enemy) => {
      const tracked = enemyAbilities(enemyDef(enemy.defId, enemy.ascension))
        .find((ability) => ability.kind === 'thorns' || ability.kind === 'beatOfDeath')
      return tracked?.kind === 'thorns' || tracked?.kind === 'beatOfDeath'
        ? { ...enemy, abilityCubes: enemy.abilityCubes ?? tracked.startingCubes }
        : enemy
    }),
    summonSupply: clone(summonSupply),
    pendingSummons: [],
    potionDeck: [...potionDeck],
    potionLimit,
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    powerTriggersUsedThisTurn: [],
    pendingTriggers: [],
    nextTriggerId: 0,
    playedCardsThisTurn: [],
    presentationEvents: [],
    log: [],
  }
}

/** Spend one Miracle for one Energy during the shared Player Turn (p.17). */
export function spendMiracle(state: CombatState, playerId: string): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.miracles < 1 || player.energy >= CAPS.energy) return state
  const next = clone(state)
  const actor = next.players.find((candidate) => candidate.id === playerId)!
  actor.miracles -= 1
  actor.energy += 1
  next.log = [...next.log, `${actor.name} spends a Miracle for 1 Energy`]
  return next
}

export type RelicContext = {
  enemyUid?: string | null
  cardUids?: string[]
  targetRelicPlayerId?: string
  targetRelicIndex?: number
  targetAbilityIndex?: number
  die?: number
  scryDiscardUids?: string[]
  shivEnemyUids?: string[]
}

function publicHandCount(player: Player): number {
  return (player as Player & { handCount?: number }).handCount ?? player.hand.length
}

/** Whether a held Relic has a legal manual activation before choosing its targets. */
export function canActivateRelic(state: CombatState, player: Player, relicIndex: number): boolean {
  const held = player.relics[relicIndex]
  if (!held || player.dead || state.pendingDistilled || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0 || (state.phase !== 'player' && state.phase !== 'start')) return false
  const def = relicDef(held.defId)
  const reroute = ['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)
  const oncePerRoll = reroute || held.defId === 'charons_ashes'
  const manual = Boolean(def.activation) || oncePerRoll || held.defId === 'holy_water'
  const postRoll = oncePerRoll || ['gambling_chip', 'the_abacus', 'toolbox'].includes(held.defId)
  if (!manual || held.spent || held.defId === 'the_courier' ||
    state.phase === 'start' && !postRoll || postRoll && (state.phase !== 'start' || state.startTurnProgress)) return false
  if (state.pendingRelicScry) return held.defId === 'golden_eye' &&
    state.pendingRelicScry.playerId === player.id && state.pendingRelicScry.relicIndex === relicIndex
  if (held.defId === 'centennial_puzzle' && !player.lostHpThisCombat ||
    held.defId === 'mummified_hand' && !player.powerPlayedThisTurn ||
    held.defId === 'red_skull' && !player.shuffledThisCombat ||
    held.defId === 'self_forming_clay' && !player.lostHpThisCombat ||
    held.defId === 'holy_water' && (held.cubes ?? 0) < 1 ||
    held.defId === 'charons_ashes' && (state.die > 2 || publicHandCount(player) === 0) ||
    held.defId === 'dollys_mirror' && state.die !== 1 ||
    held.defId === 'nilrys_codex' && state.die !== 4 ||
    held.defId === 'loaded_die' && state.die !== 6) return false
  if (reroute) {
    const face = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 2 : null
    return state.players.some((owner) => !owner.dead && owner.relics.some((target, targetRelicIndex) =>
      relicAbilities(relicDef(target.defId)).some((ability) => ability.trigger.kind === 'dieRelic' &&
        (face === null || ability.trigger.faces.includes(face)) &&
        (!['nilrys_codex', 'loaded_die'].includes(held.defId) || owner.id !== player.id || targetRelicIndex !== relicIndex))))
  }
  return true
}

/** Owner-authoritative activation for printed face-down and cube relics. */
export function activateRelic(
  state: CombatState,
  playerId: string,
  relicIndex: number,
  context: RelicContext = {},
): CombatState {
  const player = findPlayer(state, playerId)
  const held = player?.relics[relicIndex]
  if (!player || !held || !canActivateRelic(state, player, relicIndex)) return state
  const def = relicDef(held.defId)
  const oncePerRoll = ['charons_ashes', 'dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)

  if (held.defId === 'golden_eye') {
    const pending = state.pendingRelicScry
    if (!pending) {
      if (context.scryDiscardUids !== undefined) return state
      const next = clone(state)
      const actor = findPlayer(next, playerId)!
      next.pendingRelicScry = { playerId, relicIndex, cards: actor.draw.slice(0, 3) }
      return next
    }
    const chosen = context.scryDiscardUids
    if (pending.playerId !== playerId || pending.relicIndex !== relicIndex || !chosen ||
      new Set(chosen).size !== chosen.length || chosen.some((uid) => !pending.cards.some((card) => card.uid === uid))) return state
    const next = clone(state)
    const actor = findPlayer(next, playerId)!
    const result = scry(actor, 3, chosen)
    actor.draw = result.draw
    actor.hand = result.hand
    actor.discard = result.discard
    actor.relics[relicIndex]!.spent = true
    delete next.pendingRelicScry
    next.log = [...next.log, `${actor.name}'s Golden Eye Scries 3`]
    return next
  }
  if (state.pendingRelicScry) return state

  const cards = context.cardUids ?? []
  if (new Set(cards).size !== cards.length || cards.some((uid) => !player.hand.some((card) => card.uid === uid))) return state
  if (held.defId === 'blue_candle' && cards.length > 2) return state
  if (held.defId === 'centennial_puzzle' && !player.lostHpThisCombat) return state
  if (held.defId === 'mummified_hand' && !player.powerPlayedThisTurn) return state
  if (held.defId === 'red_skull' && !player.shuffledThisCombat) return state
  if (held.defId === 'self_forming_clay' && !player.lostHpThisCombat) return state
  if (held.defId === 'holy_water' && (held.cubes ?? 0) < 1) return state
  if (held.defId === 'gambling_chip' && context.die !== undefined) return state
  if (held.defId === 'charons_ashes' && (!state.die || state.die > 2 || cards.length !== 1)) return state
  if (held.defId === 'ninja_scroll') {
    const overflow = overflowShivCount(state, 2)
    if ((context.shivEnemyUids?.length ?? 0) !== overflow ||
      context.shivEnemyUids?.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))) return state
  }
  if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)) {
    const required = held.defId === 'dollys_mirror' ? 1 : held.defId === 'nilrys_codex' ? 4 : 6
    if (state.die !== required) return state
    const owner = state.players.find((candidate) => candidate.id === context.targetRelicPlayerId)
    const targetHeld = owner?.relics[context.targetRelicIndex ?? -1]
    const ability = targetHeld && relicAbilities(relicDef(targetHeld.defId))[context.targetAbilityIndex ?? 0]
    const face = ability?.trigger.kind === 'dieRelic' ? ability.trigger.faces : []
    const targetFace = held.defId === 'nilrys_codex' ? 2 : held.defId === 'dollys_mirror' ? 1 : undefined
    if (!owner || owner.dead || !ability || (targetFace !== undefined && !face.includes(targetFace)) ||
      ['nilrys_codex', 'loaded_die'].includes(held.defId) && owner.id === playerId &&
      context.targetRelicIndex === relicIndex) return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const item = actor.relics[relicIndex]!
  const spend = () => { item.spent = true }
  const source = `${actor.name}'s ${def.name}`
  if (def.activation || oncePerRoll) spend()
  if (held.defId === 'holy_water') { item.cubes!--; actor.energy = Math.min(CAPS.energy, actor.energy + 1) }
  else if (held.defId === 'akabeko') actor.akabekoAttacks = (actor.akabekoAttacks ?? 0) + 1
  else if (held.defId === 'blue_candle') {
    const chosen = cards.map((uid) => actor.hand.find((card) => card.uid === uid)!)
    actor.hand = actor.hand.filter((card) => !cards.includes(card.uid))
    exhaustCards(next, actor, chosen)
  } else if (held.defId === 'calipers') actor.calipersArmed = true
  else if (held.defId === 'centennial_puzzle') drawInto(next, actor, 3)
  else if (held.defId === 'dead_branch') drawInto(next, actor, actor.exhaust.length)
  else if (held.defId === 'gambling_chip') next.die = nextInt(next.rng, 6) + 1
  else if (held.defId === 'the_abacus') next.die = next.die === 6 ? 1 : next.die + 1
  else if (held.defId === 'toolbox') next.die = next.die === 1 ? 6 : next.die - 1
  else if (held.defId === 'mummified_hand') actor.energy = Math.min(CAPS.energy, actor.energy + 2)
  else if (held.defId === 'ninja_scroll') applyEffect(next, actor, { kind: 'gainShiv', amount: 2 }, 'self', 'self', {
    enemyUid: null,
    playerId: actor.id,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
    invalidShivTarget: false,
  }, source)
  else if (held.defId === 'red_skull') actor.strength = gainStrength(actor.strength, 1)
  else if (held.defId === 'runic_pyramid') actor.retainCardsThisTurn = cards.length
  else if (held.defId === 'self_forming_clay') actor.block = gainBlock(actor.block, 3)
  else if (held.defId === 'charons_ashes') {
    const card = actor.hand.find((candidate) => candidate.uid === cards[0])!
    actor.hand = actor.hand.filter((candidate) => candidate.uid !== card.uid)
    exhaustCards(next, actor, [card])
    const target = livingEnemies(next).find((enemy) => enemy.uid === context.enemyUid)
    if (!target) return state
    damageEnemyLogged(next, target, actor.damageDealtZeroThisTurn ? 0 : 2, source)
  } else if (['dollys_mirror', 'nilrys_codex', 'loaded_die'].includes(held.defId)) {
    const owner = findPlayer(next, context.targetRelicPlayerId!)!
    const ability = relicAbilities(relicDef(owner.relics[context.targetRelicIndex!]!.defId))[context.targetAbilityIndex ?? 0]!
    for (const effect of ability.effects) applyEffect(next, owner, effect, ability.target ?? 'enemy', ability.supportTarget ?? 'self',
      { enemyUid: context.enemyUid ?? null, playerId: owner.id }, source)
  } else return state
  next.log = [...next.log, `${source} activates`]
  return settle(next)
}

/** Spend one Shiv as its own one-damage attack (p.17). */
export function spendShiv(state: CombatState, playerId: string, enemyUid: string): CombatState {
  if (state.phase !== 'player' || state.pendingDistilled || state.pendingRelicScry ||
    state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.shivs < 1 || player.cardPlayLocked || reachedTimeWarpLimit(state, player)) {
    return state
  }
  if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) return state
  const next = clone(state)
  const actor = next.players.find((candidate) => candidate.id === playerId)!
  actor.shivs -= 1
  addPresentationEvent(next, {
    kind: 'shiv',
    actorId: actor.id,
    sourceId: 'shiv',
    enemyIds: [enemyUid],
    playerIds: [],
  })
  next.log = [...next.log, `${actor.name} spends a Shiv`]
  applyEffect(
    next,
    actor,
    { kind: 'hit', amount: 1 + actor.shivDamageBonus },
    'enemy',
    'self',
    { enemyUid, playerId },
    'Shiv',
  )
  actor.attacksPlayedThisTurn = (actor.attacksPlayedThisTurn ?? 0) + 1
  return settle(next)
}

/** Whether a held Potion has a legal activation window or required source card. */
export function canActivatePotion(state: CombatState, player: Player, potionId: string): boolean {
  if (player.dead || !player.potions.includes(potionId) || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0 || potionId === 'fairy_in_a_bottle') return false
  if (potionId === 'gamblers_brew') return state.phase === 'start' &&
    !state.startTurnProgress?.beforeDraw && !state.startTurnProgress?.rollPending &&
    !state.startTurnProgress?.discard
  return state.phase === 'player' && (potionId !== 'liquid_memories' || player.discard.length > 0)
}

/** Use and discard one held potion during the shared Player Turn (p.8, p.12). */
export function activatePotion(
  state: CombatState,
  playerId: string,
  potionId: string,
  context: PotionContext = {},
): CombatState {
  const changingDie = potionId === 'gamblers_brew'
  const player = findPlayer(state, playerId)
  if (!player || !canActivatePotion(state, player, potionId)) return state
  const def = potionDef(potionId)
  if (changingDie && (!Number.isInteger(context.die) || context.die! < 1 || context.die! > 6)) return state
  if (potionId === 'liquid_memories' && (
    !context.recoverDiscardUid || !player.discard.some((card) => card.uid === context.recoverDiscardUid)
  )) return state
  if (potionId === 'purity_potion' && (
    (context.exhaustUids?.length ?? 0) > 3 || new Set(context.exhaustUids ?? []).size !== (context.exhaustUids?.length ?? 0) ||
    (context.exhaustUids ?? []).some((uid) => !player.hand.some((card) => card.uid === uid))
  )) return state
  if (potionId === 'entropic_brew') {
    if (!player.relics.some((relic) => relic.defId === 'sozu')) {
      const overflow = Math.max(0, player.potions.length - 1 + 2 - state.potionLimit)
      const replaceable = context.replacePotionId !== potionId && player.potions.includes(context.replacePotionId ?? '')
      if (overflow > 1 || (overflow === 1) !== replaceable) return state
    }
  } else if (context.replacePotionId !== undefined) return state
  const target = def.target ?? 'enemy'
  if (def.target === 'row') {
    if (!rowExists(state, context.enemyRow)) return state
  } else if (def.target && resolveEnemyTargets(state, target, context.enemyUid ?? null).length === 0) {
    return state
  }
  if (def.supportTarget === 'anyPlayer' && context.targetPlayerId !== null && context.targetPlayerId !== undefined) {
    const chosen = findPlayer(state, context.targetPlayerId)
    if (!chosen || chosen.dead) return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  addPresentationEvent(next, {
    kind: 'potion',
    actorId: actor.id,
    sourceId: potionId,
    ...presentationTargets(next, actor.id, def.target ?? 'self', def.supportTarget ?? 'self', {
      enemyUid: context.enemyUid,
      enemyRow: context.enemyRow,
      shivEnemyUids: potionId === 'cunning_potion' ? context.shivEnemyUids : [],
      playerId: context.targetPlayerId,
    }),
  })
  actor.potions.splice(actor.potions.indexOf(potionId), 1)
  next.potionDeck.push(potionId)
  next.log = [...next.log, `${actor.name} uses ${def.name}`]
  if (changingDie) {
    next.die = context.die!
    next.log = [...next.log, `${actor.name} changes the shared die to ${context.die}`]
    return next
  }
  if (potionId === 'entropic_brew') {
    if (actor.relics.some((relic) => relic.defId === 'sozu')) {
      next.log = [...next.log, `${actor.name} cannot gain Potions because of Sozu`]
      return next
    }
    if (context.replacePotionId) {
      actor.potions.splice(actor.potions.indexOf(context.replacePotionId), 1)
      next.potionDeck.push(context.replacePotionId)
    }
    const gained = next.potionDeck.splice(0, 2)
    actor.potions.push(...gained)
    next.log = [...next.log, `${actor.name} gains ${gained.length} Potion${gained.length === 1 ? '' : 's'}`]
    return next
  }
  if (potionId === 'distilled_chaos') {
    const drawn = drawInto(next, actor, 3)
    const cards = drawn.filter((card) => actor.hand.some((held) => held.uid === card.uid))
    next.pendingDistilled = cards.length ? { playerId: actor.id, cards } : undefined
    next.log = [...next.log, `${actor.name} draws ${drawn.length} cards; ${cards.length} remain to play for 0 Energy in any order`]
    return settle(next)
  }
  const ctx: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId: context.targetPlayerId ?? null,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
    recoverDiscardUid: context.recoverDiscardUid,
    exhaustUids: context.exhaustUids,
    invalidShivTarget: false,
  }
  for (const effect of def.effects) {
    applyEffect(
      next,
      actor,
      effect,
      def.target ? target : 'self',
      def.supportTarget ?? 'self',
      ctx,
      def.name,
    )
  }
  if (potionId === 'liquid_memories' && context.recoverDiscardUid) {
    actor.hand = actor.hand.map((card) => card.uid === context.recoverDiscardUid
      ? { ...card, freeThisTurn: true }
      : card)
  }
  if (ctx.invalidShivTarget) return state
  return settle(next)
}

/** Choose the next Distilled Chaos card; normal forced-card targeting resolves it. */
export function chooseDistilledCard(state: CombatState, playerId: string, cardUid: string): CombatState {
  const pending = state.pendingDistilled
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard || state.pendingCardCopy ||
    (state.pendingTriggers?.length ?? 0) > 0 || pending?.playerId !== playerId) return state
  const queued = pending.cards.find((card) => card.uid === cardUid)
  const player = findPlayer(state, playerId)
  if (!queued || !player?.hand.some((card) => card.uid === cardUid)) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const remaining = next.pendingDistilled!.cards.filter((card) => card.uid !== cardUid)
  const def = faceOf(cardDef(queued.defId), queued.upgraded)
  next.pendingDistilled = remaining.length ? { playerId, cards: remaining } : undefined
  if (reachedTimeWarpLimit(next, actor) || !cardIsPlayable(def, next, actor) || (def.minimumX ?? 0) > 0) {
    discardByCardEffect(next, actor, [actor.hand.find((card) => card.uid === cardUid)!])
    next.log = [...next.log, `${actor.name} cannot play ${def.name}; it is discarded`]
    return settle(next)
  }
  next.startTurnProgress = {
    choices: [],
    forcedCard: {
      playerId,
      cardUid,
      sourceCardId: 'mayhem',
      sourceLabel: 'Distilled Chaos',
      exhaustNonPower: false,
    },
  }
  next.log = [...next.log, `${actor.name} chooses ${def.name} from Distilled Chaos`]
  return next
}
