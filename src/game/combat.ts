// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".
import { cardCost, faceOf, cardDef } from './cards.ts'
import type { Amount, CardDef, Condition, CountOf, Effect, TargetScope } from './cards.ts'
import { actionsFor, advanceCube, enemyDef } from './enemies.ts'
import type { EnemyAction } from './enemies.ts'
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
import { addToDrawTop, drawCards, discardHand, scry } from './piles.ts'
import { potionDef, relicDef } from './relics.ts'
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
  rng: RngState
  turn: number
  /** One shared die roll drives every die effect for the whole round (p.12). */
  die: number
  phase: CombatPhase
  players: Player[]
  enemies: Enemy[]
  discardedThisTurn: string[]
  stanceChangedThisTurn: string[]
  /** Power instance ids already spent by a printed once-per-turn ability or trigger. */
  powerTriggersUsedThisTurn: string[]
  /** Triggered abilities waiting for earlier card text or a row choice. */
  pendingTriggers: PendingTrigger[]
  nextTriggerId: number
  /** End-of-turn abilities waiting for a mandatory nested trigger. */
  endTurnProgress?: { order: EndTurnOrder }
  /** Unresolved Start-of-Turn work, including Mayhem's private forced play. */
  startTurnProgress?: {
    choices: StartTurnChoice[]
    /** The Draw step paused on a trigger before the shared die was rolled. */
    rollPending?: { drewFrom: number }
    forcedCard?: {
      playerId: string
      cardUid: string | null
      sourceCardId: string
      exhaustNonPower: boolean
      /** Draw reactions waiting for the forced card and its parent Havoc to finish. */
      pendingTriggers?: PendingTrigger[]
      /** Havoc cards waiting for their immediately-played child to finish. */
      deferredHavocs?: DeferredHavoc[]
    }
  }
  /** Card copies that must finish before any other combat action. */
  pendingCardCopy?: {
    playerId: string
    card: CardInstance
    energySpent: number
    resumePhase: 'start' | 'player'
    forcedExhaust: boolean
    forcedChoices: StartTurnChoice[] | null
    deferredHavocs: DeferredHavoc[]
    /** One entry per still-unresolved copy; different effects can stack. */
    sourceNames: ('Double Tap' | 'Echo Form')[]
  }
  log: string[]
}

export type PendingTrigger = {
  id: number
  playerId: string
  sourceId: string
}

type CopySource = 'Double Tap' | 'Echo Form'
type DeferredHavoc = {
  card: CardInstance
  exhaust: boolean
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
  /** One living enemy id or explicit skip per overflow Shiv. */
  shivEnemyUids: (string | null)[]
  /** Chosen Orb slot and Lightning/Dark target for each forced Evoke, in order. */
  evokeSlots?: number[]
  evokeEnemyUids?: (string | null)[]
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

function forgetRetain(card: CardInstance): CardInstance {
  const { retainedLastTurn: _retained, ...rest } = card
  return rest
}

export function livingEnemies(state: CombatState): Enemy[] {
  return state.enemies.filter((enemy) => !enemy.dead)
}

function findPlayer(state: CombatState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId)
}

function combatRows(state: CombatState): number[] {
  return [...new Set([
    ...state.players.map((player) => player.row),
    ...state.enemies.filter((enemy) => !enemy.isBoss).map((enemy) => enemy.row),
  ])].sort((a, b) => a - b)
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
    label: `Row ${row + 1}${boss ? ' + boss' : ''}`,
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
  const name = enemyDef(enemy.defId).name
  const sameName = enemies.filter((other) => enemyDef(other.defId).name === name)
  if (sameName.length <= 1) return name
  const sameRow = sameName.filter((other) => other.row === enemy.row)
  // The row is the natural way to tell two of a creature apart, but a row card
  // routinely puts both of them in the SAME row -- and then both print
  // "Cultist (row 0)" and the log reads as striking a corpse. Fall back to a
  // position within the row, which is the only thing left that separates them.
  if (sameRow.length <= 1) return `${name} (row ${enemy.row})`
  return `${name} (row ${enemy.row}, #${sameRow.findIndex((other) => other.uid === enemy.uid) + 1})`
}

/** Deals `damage` to an enemy, spending Block and firing Curl Up immediately. */
function damageEnemy(enemy: Enemy, damage: number): { blocked: number; curled: boolean } {
  const hpBefore = enemy.hp
  const blockBefore = enemy.block
  const outcome = applyDamage(enemy.block, enemy.hp, damage)
  enemy.block = outcome.block
  enemy.hp = outcome.hp
  if (enemy.hp === 0) enemy.dead = true
  const ability = enemyDef(enemy.defId).ability
  if (
    enemy.hp < hpBefore && !enemy.dead && !enemy.abilityUsed && ability?.kind === 'curlUp'
  ) {
    enemy.abilityUsed = true
    enemy.block = gainBlock(enemy.block, ability.block)
    return { blocked: blockBefore - outcome.block, curled: true }
  }
  return { blocked: blockBefore - outcome.block, curled: false }
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

function triggerEnemyDeathAbility(state: CombatState, enemy: Enemy): void {
  const ability = enemyDef(enemy.defId).ability
  if (ability?.kind !== 'sporeCloud') return
  const name = enemyLabel(state.enemies, enemy)
  for (const target of playersInRowOf(state, enemy)) {
    const before = target.vulnerable
    target.vulnerable = gainVulnerable(target.vulnerable, ability.vulnerable)
    if (target.vulnerable > before) {
      state.log = [...state.log, `${name}'s Spore Cloud left ${target.name} vulnerable`]
    }
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
  const result = damageEnemy(enemy, damage)
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
    triggerEnemyDeathAbility(state, enemy)
  } else if (result.curled) {
    state.log = [...state.log, `${name}'s Curl Up gained Block`]
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
  const remaining = player.hpLossLimitThisRound === undefined
    ? amount
    : Math.min(amount, Math.max(0, player.hpLossLimitThisRound - (player.hpLostThisRound ?? 0)))
  const losable = Math.min(player.hp, Math.max(0, remaining))
  if (preventPlayerHpLoss(state, player, losable)) return 0
  const outcome = applyHpLoss(player.hp, losable)
  if (outcome.hpLost > 0) {
    player.lostHpThisCombat = true
    player.hpLostThisRound = (player.hpLostThisRound ?? 0) + outcome.hpLost
  }
  player.hp = outcome.hp
  if (player.hp === 0) player.dead = true
  return outcome.hpLost
}

function damagePlayer(state: CombatState, player: Player, damage: number): boolean {
  const outcome = applyDamage(player.block, player.hp, damage)
  player.block = outcome.block
  losePlayerHp(state, player, outcome.hpLost)
  return outcome.fullyBlocked
}

/** The Energy actually charged for a card on this player's current board. */
export function playCost(def: CardDef, player: Pick<Player, 'powers' | 'lostHpThisCombat' | 'freeCardsThisTurn'>): number | 'X' {
  return (player.freeCardsThisTurn ?? 0) > 0
    ? 0
    : cardCost(def, player.powers, player.lostHpThisCombat)
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
  /** Nested reactions whose abilities wait until this card finishes. */
  pendingTriggers?: PendingTrigger[]
  /** Exhausts whose card and Power reactions wait until this card finishes its printed text. */
  pendingExhaustTriggers?: { playerId: string; card: CardInstance }[]
  /** Internal result of the immediately preceding direct draw effect. */
  drewSkill?: boolean
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
  /** Power instance currently resolving its trigger, for counters and self-Exhaust. */
  sourcePowerUid?: string
  /** The source Attack was recorded early so its later Shiv attacks follow it. */
  sourceAttackCounted?: boolean
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
): PlayContext {
  return {
    ...context,
    enemyUids: context.enemyUids ? [...context.enemyUids] : undefined,
    playerIds: context.playerIds ? [...context.playerIds] : undefined,
    topdeckUids: context.topdeckUids ? [...context.topdeckUids] : undefined,
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
    pendingTriggers: [],
    pendingExhaustTriggers: [],
    drewSkill: false,
    sourceRetainedLastTurn: held.retainedLastTurn === true,
    sourceCardType: def.type,
    sourceCardId: def.id,
    energySpent,
    sourceAttackCounted: false,
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

/** Whether a conditional printed clause applies to the current board. */
export function effectIsActive(
  effect: Effect,
  state: CombatState,
  actor: Player,
  context?: Pick<PlayContext, 'drewSkill' | 'sourceRetainedLastTurn'>,
): boolean {
  if (effect.when?.kind === 'drewSkill') return context?.drewSkill === true
  if (effect.when?.kind === 'retainedLastTurn') return context?.sourceRetainedLastTurn === true
  return !effect.when || holds(effect.when, state, actor)
}

/** Whether the card's printed play restriction currently allows it. */
export function cardPlayConditionMet(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
): boolean {
  // Online snapshots hide draw identities but publish their count.
  if (def.playCondition?.kind === 'drawPileEmpty') return drawCount === 0
  return !def.playCondition || holds(def.playCondition, state, actor)
}

/** Whether a card can resolve at all before Energy and player choices are considered. */
export function cardIsPlayable(
  def: CardDef,
  state: CombatState,
  actor: Player,
  drawCount = actor.draw.length,
): boolean {
  return !def.unplayable && cardPlayConditionMet(def, state, actor, drawCount)
}

type CountablePlayer = Pick<Player, 'id' | 'row' | 'orbs' | 'block' | 'strength' |
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
    case 'cardsInHand':
      return actor.hand?.length ?? 0
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
        enemyDef(enemy.defId), state.die, enemy.actionIndex,
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
  if (amount.bonus && holds(amount.bonus.when, state, actor, target)) total += amount.bonus.plus
  if (amount.per) total += countOf(amount.per, actor, state, context?.energySpent) * (amount.scale ?? 1)
  if (target && amount.targetTokens) {
    for (const token of amount.targetTokens) total += target[token]
  }
  return total
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
        // Every hit of a multi-hit is modified, but only ONE token comes off
        // after the whole thing resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        const hpBefore = target.hp
        const wasAlive = !target.dead
        // Bane's bonus reads the enemy being struck, so the printed number is
        // worked out per target rather than once for the card.
        const each = amountOf(effect.amount, state, actor, target, context) +
          (context.sourceCardId?.startsWith('strike_') ? (actor.starterStrikeDamageBonus ?? 0) : 0)
        let blocked = 0
        let curled = false
        let poisonAppliedTotal = 0
        let poisonEvents = 0
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          const result = damageEnemy(target, hitDamage(each, mods, { vulnerable: vulnerableAtStart }))
          blocked += result.blocked
          curled = result.curled || curled
          if (!target.dead && actor.hitPoison > 0) {
            const gained = putPoison(state, target, actor.hitPoison)
            poisonAppliedTotal += gained
            if (gained > 0) poisonEvents += 1
          }
        }
        if (vulnerableAtStart > 0) target.vulnerable = vulnerableAtStart - 1
        // One line for the whole attack, not one per swing: a five-hit card
        // would otherwise bury the round in near-identical lines.
        const name = enemyLabel(state.enemies, target)
        const lost = hpBefore - target.hp
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
          triggerEnemyDeathAbility(state, target)
        } else if (curled) {
          state.log = [...state.log, `${name}'s Curl Up gained Block`]
        }
        if (combatIsOver(state)) return
      }
      // The attacker's own Weak is spent by attacking, exactly as an enemy's is
      // (p.24). One token per attack, however many targets or hits it had.
      if (targets.length > 0 && actor.weak > 0) {
        actor.weak -= 1
        // Logged because it is usually the reason the attack underperformed.
        note(`${actor.name} spends a Weak`)
      }
      return
    }
    case 'damage': {
      // Not a hit: blockable, but unmodified by Strength/Weak/Vulnerable.
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        damageEnemyLogged(state, target, effect.amount, who)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'damagePerAttackIntent': {
      for (const target of state.enemies) {
        if (target.dead) continue
        const icons = actionsFor(enemyDef(target.defId), state.die, target.actionIndex)
          .filter((action) => action.kind === 'attack' &&
            (action.aoe || target.isBoss || target.row === actor.row))
          .reduce((total, action) => total + (action.kind === 'attack' ? action.times ?? 1 : 0), 0)
        if (icons > 0) damageEnemyLogged(state, target, effect.amount * icons, who)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'loseHp': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const name = enemyLabel(state.enemies, target)
        const wasAlive = !target.dead
        const outcome = applyHpLoss(target.hp, effect.amount)
        // What was actually lost, not what was printed: an enemy on 2 hit
        // points struck for 5 loses 2.
        state.log = [...state.log, `${name} loses ${target.hp - outcome.hp}`]
        target.hp = outcome.hp
        if (target.hp === 0) {
          target.dead = true
          // Every other kill in the game announces itself; this one used to
          // write `dead` inline and skip the line.
          if (wasAlive) state.log = [...state.log, `${name} is dead`]
          if (wasAlive) triggerEnemyDeathAbility(state, target)
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
        && holds(effect.amount.bonus.when, state, actor)
      const icons = 1 + Number(Boolean(bonusIcon))
      const amount = base + (printedCard ? icons * actor.cardBlockBonus : 0) +
        (context.sourceCardId?.startsWith('defend_') ? (actor.starterDefendBlockBonus ?? 0) : 0)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.block
        grantBlock(state, target, amount)
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
        const before = target.weak
        target.weak = gainWeak(target.weak, effect.amount)
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
      const before = actor.strength
      actor.strength = gainStrength(actor.strength, effect.amount)
      const gained = actor.strength - before
      actor.strengthLossAtEndOfTurn = (actor.strengthLossAtEndOfTurn ?? 0) +
        (effect.loseGainedOnly ? gained : effect.amount)
      if (gained > 0) note(`${actor.name} gains ${gained} Strength`)
      return
    }
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const gained = putPoison(state, target, effect.amount)
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
    case 'preventDraw': {
      actor.drawLocked = true
      note(`${actor.name} cannot draw more cards this turn`)
      return
    }
    case 'discountNextCard': {
      actor.freeCardsThisTurn = (actor.freeCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next card costs 0 this turn`)
      return
    }
    case 'doubleNextAttack': {
      actor.doubledAttacksThisTurn = (actor.doubledAttacksThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack will be played twice`)
      return
    }
    case 'doubleNextAttackOrSkill': {
      actor.doubledCardsThisTurn = (actor.doubledCardsThisTurn ?? 0) + 1
      note(`${actor.name}'s next Attack or Skill will be played twice`)
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
        if (combatIsOver(state)) return
      }
      return
    }
    case 'gainMiracle': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.miracles
        target.miracles = Math.min(CAPS.miracles, target.miracles + effect.amount)
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
      fireTriggers(state, { kind: 'onEnterStance', stance: effect.stance }, actor)
      return
    }
    case 'heal': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.hp
        target.hp = Math.min(target.maxHp, target.hp + effect.amount)
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
      discardByCardEffect(state, actor, tossed, context)
      // An empty draw pile means no cards were looked at, so nothing scried.
      if (looked > 0) fireTriggers(state, { kind: 'onScry' }, actor)
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
      const chosen = context.recoverDiscardUid
      if ((required === 1 && (!chosen || !actor.discard.some((card) => card.uid === chosen))) ||
        (required === 0 && chosen !== undefined)) {
        context.invalidRecoverChoice = true
        return
      }
      if (!chosen) return
      const moved = actor.discard.find((card) => card.uid === chosen)!
      actor.discard = actor.discard.filter((card) => card.uid !== chosen)
      if (effect.toHand) actor.hand = [...actor.hand, forgetRetain(moved)]
      else actor.draw = addToDrawTop(actor, [forgetRetain(moved)]).draw
      note(`${actor.name} returns ${faceOf(cardDef(moved.defId), moved.upgraded).name} to their ${effect.toHand ? 'hand' : 'draw pile'}`)
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
function grantBlock(state: CombatState, target: Player, amount: number): void {
  const before = target.block
  target.block = gainBlock(target.block, amount)
  if (target.block > before) fireTriggers(state, { kind: 'onGainBlock' }, target)
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
      state.log = [...state.log, `${actor.name} shuffles their discard pile back in`]
      if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      else fireTriggers(state, { kind: 'onShuffle' }, actor)
    }
    const event = { kind: 'onDraw' as const, cardType: cardDef(drawnCards[i]!.defId).type }
    if (pendingTriggers) pendingTriggers.push(...queuedTriggers(state, event, actor))
    else fireTriggers(state, event, actor)
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
  let drew = false
  for (const effect of def.effects) {
    if (state && actor && !effectIsActive(effect, state, actor)) continue
    if (effect.kind === 'searchDraw') return true
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
  const printedCost = forced?.cardUid === cardUid ? 0 : playCost(def, player)
  const cost = printedCost === 'X' ? player.energy : printedCost
  if (def.unplayable || !cardPlayConditionMet(def, state, player) ||
    cost > player.energy || !cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw') {
      return { kind: 'search', cards: actor.draw }
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
  'evoke', 'recurseOrb', 'clearTargetBlock', 'hitPerExhaust',
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
  return effects.reduce((sum, effect) => sum + (effect.kind === 'poisonChoices' ? effect.targets : 0), 0)
}

export function cardPlayerChoiceCount(def: CardDef, mode?: number): number {
  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  return effects.reduce((sum, effect) => sum + (effect.kind === 'blockChoices' ? effect.targets : 0), 0)
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

function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
  energySpent?: number,
): boolean {
  if (!cardNeedsEnemy(def, actor, includeEvokes, energySpent)) return false
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
    const ability = enemyDef(enemy.defId).ability
    if (enemy.dead || ability?.kind !== 'enraged' || state.turn < ability.fromTurn) continue
    const hpBefore = actor.hp
    const blockBefore = actor.block
    const fullyBlocked = damagePlayer(state, actor, ability.damage)
    const name = enemyLabel(state.enemies, enemy)
    const lost = hpBefore - actor.hp
    const blocked = blockBefore - actor.block
    state.log = [
      ...state.log,
      lost > 0
        ? `${name}'s Enraged hit ${actor.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : fullyBlocked
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
): void {
  const remaining = [...deferred]
  while (remaining.length > 0) {
    const { card, exhaust, copySourceNames, copyResumePhase } = remaining.pop()!
    if (combatIsOver(state)) return
    if (copySourceNames?.length) {
      fireTriggers(state, { kind: 'onPlayCard', cardType: 'skill' }, actor, card.uid)
      if (combatIsOver(state)) return
      resolveEnraged(state, actor)
      if (combatIsOver(state)) return
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
        `${actor.name}'s ${copySourceNames.join(' and ')} will play ${cardDef(card.defId).name} again`]
      return
    }
    if (exhaust) exhaustCards(state, actor, [card])
    else actor.discard = [...actor.discard, card]
    if (combatIsOver(state)) return
    fireTriggers(state, { kind: 'onPlayCard', cardType: 'skill' }, actor, card.uid)
    if (combatIsOver(state)) return
    resolveEnraged(state, actor)
  }
}

function cardResolutionChoicesAreValid(
  state: CombatState,
  player: Player,
  def: CardDef,
  effects: readonly Effect[],
  context: PlayContext,
  energySpent: number,
): boolean {
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
  if (enemyChoiceCount > 0 && (
    context.enemyUids?.length !== enemyChoiceCount ||
    context.enemyUids.some((uid) => !livingEnemies(state).some((enemy) => enemy.uid === uid))
  )) return false
  const playerChoiceCount = cardPlayerChoiceCount(def, context.mode)
  if (playerChoiceCount > 0 && (
    context.playerIds?.length !== playerChoiceCount ||
    context.playerIds.some((id) => !state.players.some((candidate) => candidate.id === id && !candidate.dead))
  )) return false

  const recover = effects.find((effect) => effect.kind === 'recoverDiscard')
  if (recover) {
    const required = Math.min(recover.amount, player.discard.length)
    const chosen = context.recoverDiscardUid
    if ((required === 1 && (!chosen || !player.discard.some((card) => card.uid === chosen))) ||
      (required === 0 && chosen !== undefined)) return false
  }
  const exhume = effects.find((effect) => effect.kind === 'recoverExhaust')
  if (exhume) {
    const required = Math.min(exhume.amount, player.exhaust.length)
    const chosen = context.recoverExhaustUid
    if ((required === 1 && (!chosen || !player.exhaust.some((card) => card.uid === chosen))) ||
      (required === 0 && chosen !== undefined)) return false
  }
  const search = effects.find((effect) => effect.kind === 'searchDraw')
  if (search) {
    const chosen = context.searchDrawUids ?? []
    const required = Math.min(search.amount, player.draw.length)
    if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
      chosen.some((uid) => !player.draw.some((card) => card.uid === uid))) return false
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
  return !needsChosenEnemy(state, def, context.enemyUid, player, !context.evokeEnemyUids, energySpent) &&
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
  const played = forgetRetain(held)
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
  if (!cardIsPlayable(def, state, player)) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  const printedCost = forcedPlay ? 0 : playCost(def, player)
  if (def.cost === 'X' && printedCost !== 'X' && (def.minimumX ?? 0) > 0) return state
  const xCost = printedCost === 'X'
  if (xCost && (!Number.isInteger(context.energySpent) || context.energySpent! < (def.minimumX ?? 0) ||
    context.energySpent! > player.energy)) return state
  if (!xCost && context.energySpent !== undefined && context.energySpent !== 0) return state
  const cost = xCost ? context.energySpent! : printedCost
  const miracleOnCard = context.spendMiracle === true
  if (forcedPlay && miracleOnCard) return state
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  // Choices are checked together at the trust boundary. The same validator is
  // reused when Double Tap resolves its separately targeted copy.
  if (!cardResolutionChoicesAreValid(state, player, def, effects, context, xCost ? cost : 0)) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  const forcedChoices = forcedPlay ? [...(state.startTurnProgress?.choices ?? [])] : null
  if (forcedPlay) next.startTurnProgress = undefined
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost
  if ((actor.freeCardsThisTurn ?? 0) > 0) actor.freeCardsThisTurn = actor.freeCardsThisTurn! - 1
  if (miracleOnCard) {
    actor.miracles -= 1
    actor.energy += 1
    next.log = [...next.log, `${actor.name} spends a Miracle toward ${def.name}`]
  }
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1

  // Logged before its effects resolve: appended afterwards, a kill the card
  // caused reads as OLDER than the card, which is nonsense in a newest-first
  // log.
  next.log = [...next.log, `${actor.name} played ${def.name}`]

  const scope: TargetScope = def.target ?? 'enemy'
  const supportScope: TargetScope = def.supportTarget ?? 'self'
  // A Power with a trigger does nothing when played: its effects are what the
  // trigger does, every time it fires. Resolving them here as well would pay
  // out Demon Form's Strength immediately AND at every Start of Turn.
  const resolvesOnPlay = def.type !== 'power' || def.resolvesOnPlay === true
  // `spentUids` and `shortfall` are this play's verdict, not the caller's
  // request, so they go on a copy. The caller's object is theirs: in the UI it
  // is assembled out of React state, and writing a scratch field back into it
  // would be a mutation from a function that is otherwise pure.
  const ctx = resolutionContext(context, def, held, xCost ? cost : 0)
  if (resolvesOnPlay) {
    for (const effect of effects) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
      if (invalidPlayChoice(ctx)) return state
      // Combat endings are immediate (p.13), including halfway through a
      // card. Nothing printed later, nor cleanup or play triggers, resolves.
      if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
    }
  }

  const copySources: CopySource[] = [
    ...((def.type === 'attack' || def.type === 'skill') && (actor.doubledCardsThisTurn ?? 0) > 0
      ? ['Echo Form' as const]
      : []),
    ...(def.type === 'attack' && (actor.doubledAttacksThisTurn ?? 0) > 0
      ? ['Double Tap' as const]
      : []),
  ]
  const doubled = copySources.length > 0

  // Havoc's child is part of Havoc's resolution. Its own cleanup, card-play
  // triggers, and Enraged reaction therefore wait until that child finishes.
  // A Havoc drawn by another Havoc extends the same small stack.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    const corrupt = def.type === 'skill' && actor.powers.some((power) => cardDef(power.defId).corruptSkills)
    if (copySources.includes('Echo Form')) actor.doubledCardsThisTurn = actor.doubledCardsThisTurn! - 1
    if (copySources.includes('Double Tap')) actor.doubledAttacksThisTurn = actor.doubledAttacksThisTurn! - 1
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

  for (const pending of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pending.playerId)
    if (owner) resolveDiscardReactions(next, owner, pending.cards)
    if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)
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
  // every pile until its copy finishes, so only that exceptional cleanup waits.
  // `held.uid` is excluded: a Power that reacts to cards being played was not
  // in front of you when THIS card was played, so it does not see it.
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, held.uid)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (def.type === 'skill') resolveEnraged(next, actor)
  if (combatIsOver(next)) return finishForcedCardPlay(settle(next), forcedChoices)

  if (doubled) {
    if (copySources.includes('Echo Form')) actor.doubledCardsThisTurn = actor.doubledCardsThisTurn! - 1
    if (copySources.includes('Double Tap')) actor.doubledAttacksThisTurn = actor.doubledAttacksThisTurn! - 1
    next.pendingCardCopy = {
      playerId: actor.id,
      card: { ...held },
      energySpent: xCost ? cost : 0,
      resumePhase: state.phase === 'start' ? 'start' : 'player',
      forcedExhaust: forcedPlay && forced.exhaustNonPower && def.type !== 'power',
      forcedChoices,
      deferredHavocs: [...(forced?.deferredHavocs ?? [])],
      sourceNames: copySources,
    }
    next.phase = 'copy'
    next.log = [...next.log, `${actor.name}'s ${copySources.join(' and ')} will play ${def.name} again`]
    releasePendingTriggers(next, ctx)
    return settle(next)
  }

  finishDeferredHavocs(next, actor, forced?.deferredHavocs ?? [])
  ctx.pendingTriggers = [...(forced?.pendingTriggers ?? []), ...(ctx.pendingTriggers ?? [])]
  releasePendingTriggers(next, ctx)
  return finishForcedCardPlay(settle(next), forcedChoices)
}

/** Resolves a separately targeted virtual card created by a play-twice effect. */
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
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  const sourceName = pending.sourceNames[0]
  if ((sourceName === 'Double Tap' && def.type !== 'attack') ||
    (sourceName === 'Echo Form' && def.type !== 'attack' && def.type !== 'skill')) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  if (!cardResolutionChoicesAreValid(state, player, def, effects, context, pending.energySpent)) return state

  const next = clone(state)
  const copy = next.pendingCardCopy!
  const actor = findPlayer(next, playerId)!
  actor.cardsPlayedThisTurn = (actor.cardsPlayedThisTurn ?? 0) + 1
  const ctx = resolutionContext(context, def, copy.card, copy.energySpent)
  next.log = [...next.log, `${actor.name} played ${def.name} again (${sourceName})`]

  for (const effect of effects) {
    applyEffect(next, actor, effect, def.target ?? 'enemy', def.supportTarget ?? 'self', ctx)
    if (invalidPlayChoice(ctx)) return state
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  // The forced child is part of a copied Havoc. Suspend this copy until that
  // child finishes, just as the original Havoc does above.
  if (def.id === 'havoc' && next.startTurnProgress?.forcedCard) {
    next.startTurnProgress.forcedCard.deferredHavocs = [
      ...copy.deferredHavocs,
      { card: { ...copy.card }, exhaust: copy.forcedExhaust },
    ]
    next.startTurnProgress.forcedCard.pendingTriggers = [...(ctx.pendingTriggers ?? [])]
    if (copy.forcedChoices) {
      next.startTurnProgress.choices = copy.forcedChoices.map((choice) => ({ ...choice }))
    }
    delete next.pendingCardCopy
    next.phase = copy.resumePhase
    return settle(next)
  }
  if (invalidPlayChoice(ctx)) return state

  for (const pendingDiscard of ctx.pendingDiscards ?? []) {
    const owner = findPlayer(next, pendingDiscard.playerId)
    if (owner) resolveDiscardReactions(next, owner, pendingDiscard.cards)
    if (combatIsOver(next)) {
      delete next.pendingCardCopy
      return finishForcedCardPlay(settle(next), copy.forcedChoices)
    }
  }
  const finalCopy = copy.sourceNames.length === 1
  if (finalCopy) cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
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
    next.log = [...next.log, `${actor.name}'s ${copy.sourceNames[0]} will play ${def.name} again`]
    releasePendingTriggers(next, ctx)
    return settle(next)
  }
  delete next.pendingCardCopy
  next.phase = copy.resumePhase
  finishDeferredHavocs(next, actor, copy.deferredHavocs)
  releasePendingTriggers(next, ctx)
  return finishForcedCardPlay(settle(next), copy.forcedChoices)
}

/** Releases a disconnected owner without letting the rest of the party deadlock. */
export function abandonCardCopy(state: CombatState, playerId: string): CombatState {
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
  cleanupPlayedCard(next, actor, copy.card, def, ctx, copy.forcedExhaust)
  for (const pendingExhaust of ctx.pendingExhaustTriggers ?? []) {
    const owner = findPlayer(next, pendingExhaust.playerId)
    if (owner) resolveExhaustReaction(next, owner, pendingExhaust.card)
  }
  next.log = [...next.log, `${actor.name}'s ${copy.sourceNames.join(' and ')} copy was skipped after disconnecting`]
  finishDeferredHavocs(next, actor, copy.deferredHavocs)
  return finishForcedCardPlay(settle(next), copy.forcedChoices)
}

/** Privately previews a copied card's post-draw or Scry choice. */
export function previewCardCopyChoice(state: CombatState, playerId: string): CardChoicePreview | null {
  const pending = state.pendingCardCopy
  const player = findPlayer(state, playerId)
  if (state.phase !== 'copy' || !pending || pending.playerId !== playerId || !player || player.dead) return null
  const def = faceOf(cardDef(pending.card.defId), pending.card.upgraded)
  if (!cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'searchDraw') {
      return { kind: 'search', cards: actor.draw }
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

function finishStartTurnDraw(next: CombatState, drewFrom: number, roll: boolean): void {
  if (roll) next.die = nextInt(next.rng, 6) + 1
  next.log = [
    ...next.log.slice(0, drewFrom),
    `Turn ${next.turn} begins${roll ? ` (die ${next.die})` : ''}`,
    ...next.log.slice(drewFrom),
  ]
}

/** Start of Turn: reset, draw 5, then roll the shared die (p.12). Mutates `next`. */
function beginPlayerTurn(next: CombatState): CombatState {
  next.phase = 'start'
  next.turn += 1
  next.discardedThisTurn = []
  next.stanceChangedThisTurn = []
  next.powerTriggersUsedThisTurn = []
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
    player.energy = 3
    if (!player.powers.some((power) => cardDef(power.defId).retainBlock)) player.block = 0
    player.drawLocked = false
    player.hpLostThisRound = 0
    player.hpLossLimitThisRound = undefined
    player.freeCardsThisTurn = 0
    player.doubledAttacksThisTurn = 0
    player.doubledCardsThisTurn = 0
    player.retainCardsThisTurn = 0
    player.cardsPlayedThisTurn = 0
    player.attacksPlayedThisTurn = 0
  }
  for (const player of next.players) {
    if (player.dead) continue
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

type StartTurnSource = { ability: Omit<StartTurnAbility, 'overflowShivs'>; source: TriggerSource }

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
  if (state.phase !== 'start') return []
  const events: TriggerEvent[] = [
    ...(state.turn === 1 ? [{ kind: 'startOfCombat' as const }] : []),
    { kind: 'startOfTurn' },
    { kind: 'dieRelic', die: state.die },
  ]
  return events.flatMap((event) => state.players.flatMap((player) => player.dead ? [] :
    triggerSources(player, event).map((source) => ({
      source,
      ability: {
        id: `${player.id}/${source.id}`,
        playerId: player.id,
        label: source.name,
        targets: triggerTargets(state, player, source),
      },
    }))))
}

function pendingStartTurnSources(state: CombatState): StartTurnSource[] {
  if (state.startTurnProgress?.forcedCard) return []
  const sources = startTurnSources(state)
  const queued = state.startTurnProgress?.choices
  if (!queued) return sources
  const ids = new Set(queued.map((choice) => choice.id))
  return sources.filter(({ ability }) => ids.has(ability.id))
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
          damageEnemy(target, (orb === 'lightning' ? 2 :
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
      const privateDraw = entry.source.effects.some((effect) => effect.kind === 'draw')
      const forcedDraw = entry.source.effects.some((effect) => effect.kind === 'drawAndPlayFree')
      if (forcedDraw) {
        planningBlocked = true
      } else if (!privateDraw) {
        const exact = clone(plannedState)
        const exactPlayer = findPlayer(exact, entry.ability.playerId)!
        if (resolveTriggerSource(
          exact, exactPlayer, entry.source, false, choice?.shivEnemyUids, choice?.enemyUid, undefined,
          choice?.evokeSlots, choice?.evokeEnemyUids,
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
  source: TriggerSource,
  choice: StartTurnChoice,
): boolean {
  const slots = choice.evokeSlots ?? []
  const targets = choice.evokeEnemyUids ?? []
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
      damageEnemy(target, (orb === 'lightning' ? 2 :
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
  const next = state
  for (let index = 0; index < choices.length; index++) {
    const choice = choices[index]!
    const entry = startTurnSources(next).find(({ ability }) => ability.id === choice.id)
    const player = entry && findPlayer(next, entry.ability.playerId)
    const ability = entry ? startTurnAbilitiesFor(next, [entry])[0] : undefined
    if (!entry || !player || !ability ||
      (ability.targets
        ? !ability.targets.some((target) => target.uid === choice.enemyUid)
        : choice.enemyUid !== undefined) ||
      !validStartTurnShivChoice(next, player, ability.overflowShivs, choice.shivEnemyUids) ||
      !validStartTurnEvokeChoice(next, player, entry.source, choice)) {
      next.startTurnProgress = { choices: choices.slice(index).map((pending) => ({ ...pending })) }
      return rollback ?? next
    }
    const checkpoint = rollback ? null : clone(next)
    if (!resolveTriggerSource(
      next, player, entry.source, false, choice.shivEnemyUids, choice.enemyUid, undefined,
      choice.evokeSlots, choice.evokeEnemyUids,
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
    if (combatIsOver(next)) return settle(next)
  }
  next.startTurnProgress = undefined
  next.phase = 'player'
  return settle(next)
}

function finishForcedCardPlay(
  state: CombatState,
  choices: readonly StartTurnChoice[] | null,
): CombatState {
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
  finishDeferredHavocs(next, actor, forced.deferredHavocs ?? [])
  releasePendingTriggers(next, {
    enemyUid: null,
    playerId: actor.id,
    pendingTriggers: forced.pendingTriggers,
  })
  return finishForcedCardPlay(settle(next), choices)
}

/** Backwards-compatible deterministic start for simulations with no UI choice. */
export function startPlayerTurn(state: CombatState): CombatState {
  const prepared = preparePlayerTurn(state)
  return prepared === state || prepared.phase !== 'start'
    ? prepared
    : resolveStartPlayerTurn(prepared, defaultStartTurnChoices(prepared))
}

/** Starts a table-facing turn, pausing only when order or overflow matters. */
export function startPlayerTurnWithChoices(state: CombatState): CombatState {
  const prepared = preparePlayerTurn(state)
  if (prepared === state || prepared.phase !== 'start') return prepared
  const abilities = startTurnAbilities(prepared)
  return abilities.length > 1 || abilities.some((ability) =>
    ability.overflowShivs > 0 || (ability.targets?.length ?? 0) > 1 || ability.evokeChoice)
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
  return [
    ...poison,
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
      const hp = player.hp
      const block = player.block
      const fullyBlocked = damagePlayer(state, player, effect.amount)
      const lost = hp - player.hp
      const blocked = block - player.block
      state.log = [...state.log, lost > 0
        ? `${def.name} damages ${player.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : fullyBlocked
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
        const outcome = applyHpLoss(enemy.hp, enemy.poison)
        const name = enemyLabel(next.enemies, enemy)
        next.log = [...next.log, `${name} loses ${enemy.hp - outcome.hp} to Poison`]
        enemy.hp = outcome.hp
        if (enemy.hp === 0) {
          enemy.dead = true
          next.log = [...next.log, `${name} is dead`]
          triggerEnemyDeathAbility(next, enemy)
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
        const hp = player.hp
        const fullyBlocked = damagePlayer(next, player, 1)
        next.log = [...next.log, hp > player.hp
          ? `${player.name} takes 1 from Wrath`
          : fullyBlocked
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
  return settle(next)
}

/** Resolves end-of-turn effects in each player's chosen order, then asks for discards. */
export function beginEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder = defaultEndTurnOrder(endTurnAbilities(state)),
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const abilities = endTurnAbilities(state)
  if (!validEndTurnOrder(abilities, order)) return state
  return continueEndPlayerTurn(clone(state), order, state)
}

/** Whether an ordered discard omits only cards this player may Retain. */
export function discardOrderIsValid(player: Player, order: readonly string[]): boolean {
  const hand = new Set(player.hand.map((card) => card.uid))
  if (new Set(order).size !== order.length || order.some((uid) => !hand.has(uid))) return false
  const ordered = new Set(order)
  const optionallyRetained = player.hand.filter((card) =>
    !ordered.has(card.uid) && !card.endTurnProtected && !faceOf(cardDef(card.defId), card.upgraded).retain)
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
      .filter((card) => !ordered.has(card.uid) && !card.endTurnProtected &&
        !faceOf(cardDef(card.defId), card.upgraded).retain)
      .map((card) => card.uid))
    const keep = hand
      .filter((held) => chosenRetain.has(held.uid) || held.endTurnProtected ||
        faceOf(cardDef(held.defId), held.upgraded).retain)
      .map((held) => held.uid)
    const piles = discardHand({ ...player, hand }, keep)
    player.draw = piles.draw
    player.hand = piles.hand.map((held) => {
      const clean = forgetRetain({ ...held, endTurnProtected: undefined })
      return chosenRetain.has(held.uid) || faceOf(cardDef(held.defId), held.upgraded).retain
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
  for (const enemy of next.enemies) enemy.block = 0

  for (const enemy of enemyActingOrder(next)) {
    if (enemy.dead) continue
    // p.13: "When a player dies, the game immediately ends in defeat."
    // Immediately — so the enemies still queued behind the killing blow never
    // get to act, and the log does not report four attacks that never landed.
    if (combatIsOver(next)) break
    const def = enemyDef(enemy.defId)
    for (const action of actionsFor(def, next.die, enemy.actionIndex)) {
      applyEnemyAction(next, enemy, action)
      if (combatIsOver(next)) break
    }
  }

  for (const enemy of next.enemies) {
    if (enemy.dead) continue
    enemy.actionIndex = advanceCube(enemyDef(enemy.defId), enemy.actionIndex)
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
  const isLast = (enemy: Enemy) => enemy.isBoss || enemyDef(enemy.defId).actsLast === true
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
  return state.players.filter((player) => !player.dead && player.row === enemy.row)
}

function applyEnemyAction(state: CombatState, enemy: Enemy, action: EnemyAction): void {
  const living = state.players.filter((player) => !player.dead)
  const name = enemyLabel(state.enemies, enemy)

  switch (action.kind) {
    case 'attack': {
      const targets = action.aoe ? living : playersInRowOf(state, enemy)
      const mods = attackerModsOfEnemy(enemy)
      for (const target of targets) {
        // Every hit is modified, but only one Vulnerable token comes off after
        // the whole action resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        const hpBefore = target.hp
        const blockBefore = target.block
        let fullyBlocked = true
        for (let i = 0; i < (action.times ?? 1); i++) {
          if (target.dead) break
          fullyBlocked = damagePlayer(
            state,
            target,
            hitDamage(action.amount, mods, { vulnerable: vulnerableAtStart }),
          ) && fullyBlocked
        }
        if (vulnerableAtStart > 0) {
          target.vulnerable = vulnerableAtStart - 1
          // A token leaving the board deserves the line its arrival got.
          state.log = [...state.log, `${target.name} spends a Vulnerable`]
        }
        // The log is the only record of what happened during the Enemy Turn:
        // without it a player sees a number quietly change and has to guess.
        const lost = hpBefore - target.hp
        const blocked = blockBefore - target.block
        // Only credit Block when Block actually did something: a Weak attack
        // reduced to nothing is not the shield's doing.
        state.log = [
          ...state.log,
          lost > 0
            ? `${name} hit ${target.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
            : fullyBlocked && blocked > 0
              ? `${target.name} blocked ${name} completely (${blocked} spent)`
              : `${name} did no damage to ${target.name}${blocked > 0 ? ` (${blocked} blocked)` : ''}`,
        ]
        if (target.dead) {
          state.log = [...state.log, `${target.name} has fallen`]
          // The rest of the sweep never lands: the game ended on this blow.
          break
        }
      }
      // One Weak token comes off after the whole action, not per hit — and only
      // if the action actually attacked something. An enemy swinging at an
      // empty row has not attacked (p.24), same rule as the player side.
      if (targets.length > 0 && enemy.weak > 0) {
        enemy.weak -= 1
        state.log = [...state.log, `${name} spends a Weak`]
      }
      return
    }
    case 'block': {
      // The amount actually gained, not the amount printed: at the cap the
      // enemy gains nothing and the log should not claim otherwise.
      const before = enemy.block
      enemy.block = gainBlock(enemy.block, action.amount)
      if (enemy.block > before) {
        state.log = [...state.log, `${name} gained ${enemy.block - before} Block`]
      }
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
  const open = actor.orbs.indexOf(null)
  if (open >= 0) {
    actor.orbs[open] = orb
    return true
  }
  // A full set forces an evoke to make room (p.16). Unsaid, the evoke's line
  // appeared with nothing to explain why an orb had vanished.
  state.log = [...state.log, `${actor.name} has no free orb slot, and must evoke to make room`]
  evokeOrb(state, actor, context)
  if (combatIsOver(state)) return false
  const freed = actor.orbs.indexOf(null)
  if (freed < 0) return false
  actor.orbs[freed] = orb
  return true
}

function applyOrbEvokeEffect(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  chosenTarget: string | null | undefined,
  sourceCardId?: string,
): boolean {
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, chosenTarget, sourceCardId)
    if (!targets) return false
    for (const target of targets) {
      damageEnemyLogged(state, target, 2 + (actor.orbEvokeBonus ?? 0), `${actor.name}'s Lightning orb`)
    }
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1 + (actor.orbEvokeBonus ?? 0))
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
    if (!applyOrbEvokeEffect(state, actor, orb, chosenTarget, context.sourceCardId) &&
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
    const index = Number(id.slice(6))
    const held = Number.isInteger(index) ? player.relics[index] : undefined
    if (!held) return undefined
    const def = relicDef(held.defId)
    return {
      id,
      trigger: def.trigger,
      effects: def.effects,
      name: `${player.name}'s ${def.name}`,
      scope: 'enemy',
      supportScope: 'self',
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
    const source = triggerSourceById(player, `relic:${index}`)!
    if (triggerMatches(source.trigger, event)) sources.push(source)
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
    })))
}

function triggerNeedsRowChoice(state: CombatState, player: Player, source: TriggerSource): boolean {
  return source.scope === 'row' && source.effects.some((effect) => reachesEnemy(effect, player)) &&
    combatRows(state).length > 1
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
    playerId: player.id,
    shivEnemyUids: shivEnemyUids ? [...shivEnemyUids] : undefined,
    shivTargetIndex: 0,
    invalidShivTarget: false,
    evokeSlots: evokeSlots ? [...evokeSlots] : undefined,
    evokeEnemyUids: evokeEnemyUids ? [...evokeEnemyUids] : undefined,
    evokeIndex: 0,
    invalidEvokeTarget: false,
    sourcePowerUid: source.powerUid,
    pendingTriggers,
  }
  for (const effect of source.effects) {
    applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
    if (!allowCombatOver && combatIsOver(state)) return true
  }
  const forced = state.startTurnProgress?.forcedCard
  if (forced && pendingTriggers.length > 0) {
    forced.pendingTriggers = [...(forced.pendingTriggers ?? []), ...pendingTriggers]
  } else {
    releasePendingTriggers(state, context)
  }
  return !context.invalidShivTarget && !context.invalidEvokeTarget
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
    if (triggerNeedsRowChoice(state, player, source)) return
    state.pendingTriggers.shift()
    resolveTriggerSource(
      state,
      player,
      source,
      false,
      undefined,
      undefined,
      source.scope === 'row' ? combatRows(state)[0] : undefined,
    )
  }
}

export type PendingTriggerAbility = {
  id: number
  playerId: string
  label: string
  rows?: { row: number; label: string }[]
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
      ? combatRows(state).map((row) => ({ row, label: `Row ${row + 1}` }))
      : undefined,
  }
}

/** Resolve the oldest triggered ability before any other combat action. */
export function resolvePendingTrigger(
  state: CombatState,
  playerId: string,
  triggerId: number,
  enemyRow?: number,
): CombatState {
  const pending = state.pendingTriggers?.[0]
  if (!pending || pending.playerId !== playerId || pending.id !== triggerId) return state
  const player = findPlayer(state, playerId)
  const source = player && triggerSourceById(player, pending.sourceId)
  if (!player || player.dead || !source) return state
  const needsRow = triggerNeedsRowChoice(state, player, source)
  if ((needsRow && !rowExists(state, enemyRow)) || (!needsRow && enemyRow !== undefined)) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const queued = next.pendingTriggers.shift()!
  const liveSource = triggerSourceById(actor, queued.sourceId)!
  resolveTriggerSource(
    next,
    actor,
    liveSource,
    false,
    undefined,
    undefined,
    needsRow ? enemyRow : liveSource.scope === 'row' ? combatRows(next)[0] : undefined,
  )
  flushPendingTriggers(next)
  const rollPending = next.startTurnProgress?.rollPending
  if (rollPending && (next.pendingTriggers.length === 0 || combatIsOver(next))) {
    next.startTurnProgress = undefined
    finishStartTurnDraw(next, rollPending.drewFrom, !combatIsOver(next))
  }
  const settled = settle(next)
  if ((settled.pendingTriggers?.length ?? 0) === 0 && settled.phase === 'start' &&
    settled.startTurnProgress && !settled.startTurnProgress.forcedCard) {
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
        triggerNeedsRowChoice(state, player, source))) {
        state.pendingTriggers ??= []
        state.nextTriggerId ??= 0
        state.pendingTriggers.push({ id: state.nextTriggerId++, playerId: player.id, sourceId: source.id })
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
 * Both are immediate (p.13), so anything still queued behind them — another
 * player's orb, their Wrath bite, the next enemy in the order — must not
 * resolve at all.
 */
function combatIsOver(state: CombatState): boolean {
  return state.enemies.every((enemy) => enemy.dead) || state.players.some((player) => player.dead)
}

/** Decides whether the combat has ended, and returns the state either way. */
function settle(state: CombatState): CombatState {
  // Victory is tested first, but the ordering no longer decides anything on
  // its own: `combatIsOver` stops each phase at the moment either ending
  // happens, so this is never reached with a dead player AND a wiped board.
  // It is kept in this order as a backstop for a state assembled by hand.
  if (state.enemies.every((enemy) => enemy.dead)) {
    state.pendingTriggers = []
    delete state.endTurnProgress
    delete state.pendingCardCopy
    delete state.startTurnProgress
    state.phase = 'won'
    fireTriggers(state, { kind: 'endOfCombat' })
    return state
  }
  // p.13: ONE death, not a wipe. This is a co-op game where the party stands
  // or falls together, and last-man-standing is a much easier game.
  if (state.players.some((player) => player.dead)) {
    state.pendingTriggers = []
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
): CombatState {
  return {
    rng,
    turn: 0,
    die: 1,
    phase: 'player',
    players: players.map((player) => ({
      ...player,
      lostHpThisCombat: false,
      hpLostThisRound: 0,
      hpLossLimitThisRound: undefined,
      freeCardsThisTurn: 0,
      doubledAttacksThisTurn: 0,
      doubledCardsThisTurn: 0,
      retainCardsThisTurn: 0,
      cardsPlayedThisTurn: 0,
      attacksPlayedThisTurn: 0,
      wrathAttackDamageBonus: 0,
      shivDamageBonus: 0,
      cardBlockBonus: 0,
      hitPoison: 0,
      starterStrikeDamageBonus: 0,
      clawCubesGainedThisCombat: 0,
      starterDefendBlockBonus: 0,
      darkOrbEvokeBonus: 0,
      lightningEndTurnBonus: 0,
    })),
    enemies,
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    powerTriggersUsedThisTurn: [],
    pendingTriggers: [],
    nextTriggerId: 0,
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

/** Spend one Shiv as its own one-damage attack (p.17). */
export function spendShiv(state: CombatState, playerId: string, enemyUid: string): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.dead || player.shivs < 1) return state
  if (resolveEnemyTargets(state, 'enemy', enemyUid).length === 0) return state
  const next = clone(state)
  const actor = next.players.find((candidate) => candidate.id === playerId)!
  actor.shivs -= 1
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

/** Use and discard one held potion during the shared Player Turn (p.8, p.12). */
export function activatePotion(
  state: CombatState,
  playerId: string,
  potionId: string,
  context: PotionContext = {},
): CombatState {
  if (state.phase !== 'player' || state.startTurnProgress?.forcedCard ||
    (state.pendingTriggers?.length ?? 0) > 0) return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead || !player.potions.includes(potionId)) return state
  const def = potionDef(potionId)
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
  actor.potions.splice(actor.potions.indexOf(potionId), 1)
  next.log = [...next.log, `${actor.name} uses ${def.name}`]
  const ctx: PlayContext = {
    enemyUid: context.enemyUid ?? null,
    enemyRow: context.enemyRow,
    playerId: context.targetPlayerId ?? null,
    shivEnemyUids: context.shivEnemyUids,
    shivTargetIndex: 0,
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
  if (ctx.invalidShivTarget) return state
  return settle(next)
}
