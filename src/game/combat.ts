// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".
import { faceOf, cardDef } from './cards.ts'
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
import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import { CAPS } from './types.ts'
import type { CardInstance, Enemy, OrbType, Player } from './types.ts'

export type CombatPhase =
  | 'player'
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
  log: string[]
}

export type DiscardOrders = Readonly<Record<string, readonly string[]>>
export type EndTurnOrder = readonly string[]
export type EndTurnAbility = {
  id: string
  playerId: string | null
  label: string
  targets?: { uid: string; label: string }[]
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

export function livingEnemies(state: CombatState): Enemy[] {
  return state.enemies.filter((enemy) => !enemy.dead)
}

function findPlayer(state: CombatState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId)
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

function damagePlayer(player: Player, damage: number): void {
  const outcome = applyDamage(player.block, player.hp, damage)
  player.block = outcome.block
  player.hp = outcome.hp
  if (player.hp === 0) player.dead = true
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
  /** Another living player whose row is optionally exchanged with the caster's. */
  switchWithPlayerId?: string | null
  /** Zero-based printed mode for a modal card face. */
  mode?: number
  /** Cards chosen to discard, for effects like Survivor. */
  discardUids?: string[]
  /** Cards chosen to exhaust from hand, for effects like True Grit. */
  exhaustUids?: string[]
  /** Spend one Miracle atomically with this card, which may take Energy above 6. */
  spendMiracle?: boolean
  /** One chosen target per overflow Shiv, because each is a separate attack. */
  shivEnemyUids?: string[]
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
  /** A queued evoke named an enemy killed by an earlier effect. */
  invalidEvokeTarget?: boolean
  /** A Scry named a card outside the cards it actually revealed. */
  invalidScryChoice?: boolean
}

export type CardChoicePreview = {
  kind: 'discard' | 'scry'
  cards: CardInstance[]
}

export type PotionContext = {
  enemyUid?: string | null
  targetPlayerId?: string | null
  enemyRow?: number | null
  shivEnemyUids?: string[]
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
      return face.cost === condition.cost
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
    case 'hasNoAttacksInHand':
      return actor.hand.every((card) => cardDef(card.defId).type !== 'attack')
    case 'goldAtLeast':
      return actor.gold >= condition.amount
    case 'orbsAtLeast':
      return actor.orbs.filter((orb) => orb !== null).length >= condition.amount
  }
}

/** Whether a conditional printed clause applies to the current board. */
export function effectIsActive(effect: Effect, state: CombatState, actor: Player): boolean {
  return !effect.when || holds(effect.when, state, actor)
}

type CountablePlayer = Pick<Player, 'orbs' | 'block' | 'strength'> & {
  hand: readonly CardInstance[] | null
}

/** What a card counts off the board. */
function countOf(count: CountOf, actor: CountablePlayer): number {
  switch (count) {
    case 'orbs':
      return actor.orbs.filter((orb) => orb !== null).length
    case 'orbTypes':
      return new Set(actor.orbs.filter((orb) => orb !== null)).size
    case 'block':
      return actor.block
    case 'strength':
      return actor.strength
    case 'cardsInHand':
      return actor.hand?.length ?? 0
  }
}

/** The number a clause actually uses, once the board has been read. */
function amountOf(
  amount: Amount,
  state: CombatState,
  actor: Player,
  target?: Enemy,
): number {
  if (typeof amount === 'number') return amount
  let total = amount.base
  if (amount.bonus && holds(amount.bonus.when, state, actor, target)) total += amount.bonus.plus
  if (amount.per) total += countOf(amount.per, actor) * (amount.scale ?? 1)
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
  if (!effectIsActive(effect, state, actor)) return

  switch (effect.kind) {
    case 'hit': {
      const targets = resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)
      // Barrage deals one hit per Orb, so the swing count is read off the board
      // once, before the first target — not per target, which would let an
      // area-of-effect card re-count between enemies.
      const times = effect.times === undefined ? 1 : amountOf(effect.times, state, actor)
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
        const each = amountOf(effect.amount, state, actor, target)
        let blocked = 0
        let curled = false
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          const result = damageEnemy(target, hitDamage(each, mods, { vulnerable: vulnerableAtStart }))
          blocked += result.blocked
          curled = result.curled || curled
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
      const outcome = applyHpLoss(actor.hp, effect.amount)
      actor.hp = outcome.hp
      if (actor.hp === 0) actor.dead = true
      note(`${actor.name} loses ${outcome.hpLost} HP`)
      return
    }
    case 'block': {
      // Deflect and Steam Barrier both read the CASTER's board, not the ally
      // they may be handing the Block to, so this is worked out once.
      const amount = amountOf(effect.amount, state, actor)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.block
        grantBlock(state, target, amount)
        if (target.block > before) note(`${target.name} gains ${target.block - before} Block`)
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
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid, context.enemyRow)) {
        const before = target.weak
        target.weak = gainWeak(target.weak, effect.amount)
        if (target.weak > before) note(`${enemyLabel(state.enemies, target)} is weakened`)
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
        const before = target.poison
        target.poison = gainPoison(target.poison, effect.amount, totalPoisonInPlay(state.enemies))
        if (target.poison > before) {
          note(`${enemyLabel(state.enemies, target)} takes ${target.poison - before} Poison`)
        }
      }
      return
    }
    case 'draw': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const before = target.hand.length
        // Reserve the line before drawing: a draw can reshuffle and fire
        // triggers that log, and those belong under this line, not above it.
        const at = state.log.length
        drawInto(state, target, amountOf(effect.amount, state, actor))
        const drawn = target.hand.length - before
        if (drawn > 0) {
          const line = source ? `${source}: ${target.name} draws ${drawn}` : `${target.name} draws ${drawn}`
          state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
        }
      }
      return
    }
    case 'preventDraw': {
      actor.drawLocked = true
      note(`${actor.name} cannot draw more cards this turn`)
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
            { kind: 'hit', amount: 1 },
            'enemy',
            'self',
            { ...context, enemyUid },
            'Shiv',
          )
          if (combatIsOver(state)) return
        }
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
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      actor.discard = [...actor.discard, ...moved]
      if (moved.length > 0) {
        if (!state.discardedThisTurn.includes(actor.id)) state.discardedThisTurn.push(actor.id)
        note(`${actor.name} discards ${moved.length}`)
      }
      return
    }
    case 'exhaustFromHand': {
      const chosen = allocate(actor, context.exhaustUids, effect.amount, context)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      exhaustCards(state, actor, moved)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'channel': {
      // Reserve the line's position before forced evokes log, but write it only
      // after an Orb was really placed: a lethal forced evoke ends combat first.
      const at = state.log.length
      let channeled = 0
      for (let i = 0; i < effect.amount; i++) {
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
      if (face.unplayable || face.cost !== effect.cost) return
      actor.discard = actor.discard.slice(0, -1)
      actor.hand = [...actor.hand, top]
      note(`${actor.name} returns ${face.name} to hand`)
      return
    }
    case 'evoke': {
      for (let i = 0; i < effect.times; i++) {
        if (actor.orbs.every((orb) => orb == null)) {
          // Dual Cast evokes twice; with one orb charged the second found
          // nothing, and said nothing.
          note(`${actor.name} has no orb left to evoke`)
          break
        }
        evokeOrb(state, actor, context)
        if (combatIsOver(state)) return
      }
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
    case 'removeAllOrbs': {
      const removed = actor.orbs.filter((orb) => orb !== null).length
      actor.orbs = actor.orbs.map(() => null)
      if (removed > 0) note(`${actor.name} removes ${removed} Orbs`)
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
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard },
        effect.amount, chosen)
      actor.draw = piles.draw
      actor.discard = piles.discard
      // An empty draw pile means no cards were looked at, so nothing scried.
      if (looked > 0) fireTriggers(state, { kind: 'onScry' }, actor)
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
function drawInto(state: CombatState, actor: Player, amount: number): void {
  if (actor.drawLocked) return
  const result = drawCards(state.rng, actor, amount)
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
      fireTriggers(state, { kind: 'onShuffle' }, actor)
    }
    fireTriggers(state, { kind: 'onDraw' }, actor)
  }
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
function exhaustCards(state: CombatState, actor: Player, cards: readonly Player['hand'][number][]): void {
  const lasting = cards.filter((held) => cardDef(held.defId).owner !== 'status')
  actor.exhaust = [...actor.exhaust, ...lasting]
  for (let i = 0; i < cards.length; i++) fireTriggers(state, { kind: 'onExhaust' }, actor)
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
    if (effect.kind === 'draw') drew = true
    if (effect.kind === 'scry' || (drew && effect.kind === 'discard')) return true
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
  if (state.phase !== 'player') return null
  const player = findPlayer(state, playerId)
  const held = player?.hand.find((card) => card.uid === cardUid)
  if (!player || player.dead || !held) return null
  const def = faceOf(cardDef(held.defId), held.upgraded)
  const cost = def.cost === 'X' ? player.energy : def.cost
  if (def.unplayable || cost > player.energy || !cardNeedsChoicePreview(def, state, player)) return null

  const preview = clone(state)
  const actor = findPlayer(preview, playerId)!
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  let drew = false
  for (const effect of def.effects) {
    if (!effectIsActive(effect, preview, actor)) continue
    if (effect.kind === 'draw') {
      drawInto(preview, actor, amountOf(effect.amount, preview, actor))
      drew = true
    } else if (effect.kind === 'scry') {
      return { kind: 'scry', cards: actor.draw.slice(0, effect.amount) }
    } else if (drew && effect.kind === 'discard') {
      return { kind: 'discard', cards: actor.hand }
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
  'hit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'evoke', 'recurseOrb', 'clearTargetBlock',
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
): boolean {
  if (!ENEMY_EFFECTS.includes(effect.kind)) return false
  if (effect.kind !== 'hit' || effect.times === undefined || !actor) return true
  const times = effect.times
  if (typeof times === 'number') return times > 0
  if (times.bonus) return true
  return times.base + (times.per ? countOf(times.per, actor) : 0) > 0
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
): boolean {
  if (def.type === 'power' && def.trigger) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  const effects = def.modes?.flatMap((mode) => mode.effects) ?? def.effects
  return effects.some((effect) =>
    (includeEvokes || (effect.kind !== 'evoke' && effect.kind !== 'recurseOrb')) && reachesEnemy(effect, actor))
}

export type EvokeChoice = { index: number; options: { slot: number; orb: OrbType }[] }

function evokePlan(def: CardDef, actor: Pick<Player, 'orbs'>, slots: readonly number[], mode?: number) {
  const orbs = [...actor.orbs]
  const chosen: OrbType[] = []
  let index = 0
  let next: EvokeChoice | null = null
  let invalid = false

  const evoke = () => {
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
    chosen.push(picked.orb)
    orbs[slot] = null
    index += 1
    return true
  }

  const effects = def.modes ? def.modes[mode ?? -1]?.effects ?? [] : def.effects
  for (const effect of effects) {
    if (effect.when?.kind === 'orbsAtLeast' &&
      orbs.filter((orb) => orb !== null).length < effect.when.amount) continue
    if (effect.kind === 'channel' || effect.kind === 'channelDieOrb') {
      const amount = effect.kind === 'channel' ? effect.amount : 1
      for (let count = 0; count < amount; count++) {
        if (orbs.every((orb) => orb !== null) && !evoke()) return { chosen, index, next, invalid }
        const open = orbs.indexOf(null)
        if (open >= 0) orbs[open] = effect.kind === 'channel' ? effect.orb : 'lightning'
      }
    } else if (effect.kind === 'evoke' || effect.kind === 'recurseOrb') {
      if (effect.kind === 'recurseOrb') {
        if (!evoke()) return { chosen, index, next, invalid }
        const open = orbs.indexOf(null)
        const orb = chosen.at(-1)
        if (open >= 0 && orb) orbs[open] = orb
        continue
      }
      for (let count = 0; count < effect.times; count++) if (!evoke()) return { chosen, index, next, invalid }
    }
  }
  return { chosen, index, next, invalid }
}

/** The next Orb choice a staged card needs, after its earlier choices. */
export function nextEvokeChoice(
  def: CardDef,
  actor: Pick<Player, 'orbs'>,
  slots: readonly number[],
  mode?: number,
): EvokeChoice | null {
  return evokePlan(def, actor, slots, mode).next
}

function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
  includeEvokes = true,
): boolean {
  if (!cardNeedsEnemy(def, actor, includeEvokes)) return false
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
  if (state.phase !== 'player') return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead) return state

  const held = player.hand.find((card) => card.uid === cardUid)
  if (!held) return state

  const def = faceOf(cardDef(held.defId), held.upgraded)
  if (def.unplayable) return state
  if (def.modes) {
    if (!Number.isInteger(context.mode) || context.mode! < 0 || context.mode! >= def.modes.length) return state
  } else if (context.mode !== undefined) return state
  const effects = def.modes ? def.modes[context.mode!]!.effects : def.effects
  const cost = def.cost === 'X' ? player.energy : def.cost
  const miracleOnCard = context.spendMiracle === true
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  const plan = evokePlan(def, player, context.evokeSlots ?? [], context.mode)
  if (plan.invalid || plan.next || plan.index !== (context.evokeSlots?.length ?? 0)) return state
  if (plan.chosen.length > 0 && (!context.evokeSlots || !context.evokeEnemyUids)) return state
  if (context.evokeEnemyUids) {
    if (!context.evokeSlots || context.evokeEnemyUids.length !== plan.chosen.length) return state
    for (let index = 0; index < plan.chosen.length; index++) {
      const target = context.evokeEnemyUids[index]
      if (plan.chosen[index] === 'frost') {
        if (target !== null) return state
      } else if (typeof target !== 'string' || !livingEnemies(state).some((enemy) => enemy.uid === target)) {
        return state
      }
    }
  }
  // A card that must pick an enemy but was given none would otherwise spend the
  // Energy, discard itself and do nothing. The UI never allows it, but the room
  // server hands this function messages straight off the network, so the check
  // belongs here rather than in the client.
  if (needsChosenEnemy(state, def, context.enemyUid, player, !context.evokeEnemyUids)) return state
  // A co-op target can die or disconnect after the client stages the card.
  // Refuse the stale command instead of silently redirecting its support
  // effect to the caster.
  if (hasInvalidChosenPlayer(state, def, context.playerId)) return state
  if (hasInvalidRowSwitch(state, effects, context.switchWithPlayerId, player)) return state
  // Evoking with no orbs charged the Energy, discarded the card and did
  // nothing at all — with the UI still asking which enemy to point it at.
  if (effects.some((effect) => effect.kind === 'evoke' || effect.kind === 'recurseOrb') &&
    player.orbs.every((orb) => !orb)) {
    return state
  }

  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost
  if (miracleOnCard) {
    actor.miracles -= 1
    actor.energy += 1
    next.log = [...next.log, `${actor.name} spends a Miracle toward ${def.name}`]
  }

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
  const ctx: PlayContext = {
    ...context,
    shivEnemyUids: context.shivEnemyUids ? [...context.shivEnemyUids] : undefined,
    evokeSlots: context.evokeSlots ? [...context.evokeSlots] : undefined,
    evokeEnemyUids: context.evokeEnemyUids ? [...context.evokeEnemyUids] : undefined,
    spentUids: new Set<string>(),
    shortfall: false,
    shivTargetIndex: 0,
    invalidShivTarget: false,
    evokeIndex: 0,
    invalidEvokeTarget: false,
    invalidScryChoice: false,
  }
  if (resolvesOnPlay) {
    for (const effect of effects) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
      // Combat endings are immediate (p.13), including halfway through a
      // card. Nothing printed later, nor cleanup or play triggers, resolves.
      if (combatIsOver(next)) return settle(next)
    }
  }

  // Survivor reads "2 Block. Discard 1 card." — the discard is the COST, not a
  // suggestion. Off the network an empty or bogus list would otherwise buy the
  // card's effects for nothing. The whole play is resolved into a clone first,
  // so refusing it here costs the caller nothing and still signals illegality
  // the way every other refusal does: by handing back the very same reference.
  if (ctx.shortfall || ctx.invalidShivTarget || ctx.invalidEvokeTarget || ctx.invalidScryChoice) return state

  if (def.exhaust) {
    exhaustCards(next, actor, [held])
  } else if (def.type === 'power') {
    actor.powers = [...actor.powers, held]
  } else if (def.toDrawTop) {
    actor.draw = addToDrawTop(actor, [held]).draw
  } else {
    actor.discard = [...actor.discard, held]
  }

  // "Abilities triggered by a card do not take effect until the card has
  // finished resolving all of its text" (p.12) — so this fires after cleanup.
  // `held.uid` is excluded: a Power that reacts to cards being played was not
  // in front of you when THIS card was played, so it does not see it.
  fireTriggers(next, { kind: 'onPlayCard', cardType: def.type }, actor, held.uid)

  if (def.type === 'skill') {
    for (const enemy of next.enemies) {
      const ability = enemyDef(enemy.defId).ability
      if (enemy.dead || ability?.kind !== 'enraged' || next.turn < ability.fromTurn) continue
      const hpBefore = actor.hp
      const blockBefore = actor.block
      damagePlayer(actor, ability.damage)
      const name = enemyLabel(next.enemies, enemy)
      const lost = hpBefore - actor.hp
      const blocked = blockBefore - actor.block
      next.log = [
        ...next.log,
        lost > 0
          ? `${name}'s Enraged hit ${actor.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
          : `${actor.name} blocked ${name}'s Enraged (${blocked} spent)`,
      ]
      if (actor.dead) {
        next.log = [...next.log, `${actor.name} has fallen`]
        break
      }
    }
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
export function startPlayerTurn(state: CombatState): CombatState {
  const opening = state.turn === 0
  if (!opening && state.phase !== 'roundEnd') return state
  return beginPlayerTurn(clone(state))
}

/** Start of Turn: reset, draw 5, roll the shared die (p.12). Mutates `next`. */
function beginPlayerTurn(next: CombatState): CombatState {
  next.phase = 'player'
  next.turn += 1
  next.discardedThisTurn = []
  next.stanceChangedThisTurn = []
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
    player.block = 0
    player.drawLocked = false
  }
  for (const player of next.players) {
    if (player.dead) continue
    drawInto(next, player, 5)
  }

  // One roll per round; every die effect this round reads this value.
  next.die = nextInt(next.rng, 6) + 1

  // The divider opens the round, so it is written before anything the round
  // contains. The draw above can itself fire a trigger once an on-draw Power
  // is transcribed, and those lines belong under this heading, not the
  // previous one — so the divider is spliced in ahead of them.
  next.log = [
    ...next.log.slice(0, drewFrom),
    `Turn ${next.turn} begins (die ${next.die})`,
    ...next.log.slice(drewFrom),
  ]

  // Start-of-combat abilities only fire on turn 1 (p.12).
  if (next.turn === 1) fireTriggers(next, { kind: 'startOfCombat' })
  fireTriggers(next, { kind: 'startOfTurn' })
  // Die relics fire after the roll, during Start of Turn (p.19).
  fireTriggers(next, { kind: 'dieRelic', die: next.die })

  // A start-of-turn ability can kill the last enemy, and a combat that is over
  // must say so — otherwise the phase stays 'player' and endOfCombat is missed.
  return settle(next)
}

function playerEndTurnAbilities(state: CombatState, player: Player): Omit<EndTurnAbility, 'playerId'>[] {
  const abilities: Omit<EndTurnAbility, 'playerId'>[] = triggerSources(player, { kind: 'endOfTurn' })
    .map((source) => ({ id: source.id, label: source.name.replace(`${player.name}'s `, '') }))
  if ((player.strengthLossAtEndOfTurn ?? 0) > 0) {
    abilities.push({ id: 'strength', label: 'Lose temporary Strength' })
  }
  player.orbs.forEach((orb, slot) => {
    if (orb === 'lightning') {
      abilities.push({
        id: `orb:${slot}`,
        label: `Lightning Orb ${slot + 1}`,
        targets: livingEnemies(state).map((enemy) => ({ uid: enemy.uid, label: enemyLabel(state.enemies, enemy) })),
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
      damagePlayer(player, effect.amount)
      const lost = hp - player.hp
      const blocked = block - player.block
      state.log = [...state.log, lost > 0
        ? `${def.name} damages ${player.name} for ${lost}${blocked > 0 ? ` (${blocked} blocked)` : ''}`
        : `${player.name} blocks ${def.name}${blocked > 0 ? ` (${blocked} spent)` : ''}`]
    } else if (effect.kind === 'loseHp') {
      const outcome = applyHpLoss(player.hp, effect.amount)
      state.log = [...state.log, `${def.name}: ${player.name} loses ${outcome.hpLost} HP`]
      player.hp = outcome.hp
      if (player.hp === 0) player.dead = true
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

/** Resolves end-of-turn effects in each player's chosen order, then asks for discards. */
export function beginEndPlayerTurn(
  state: CombatState,
  order: EndTurnOrder = defaultEndTurnOrder(endTurnAbilities(state)),
): CombatState {
  if (state.phase !== 'player') return state
  const abilities = endTurnAbilities(state)
  if (!validEndTurnOrder(abilities, order)) return state

  const next = clone(state)
  for (const choice of order) {
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
        if (source) resolveTriggerSource(next, player, source)
      } else if (localId === 'strength') {
        const loss = Math.min(player.strength, player.strengthLossAtEndOfTurn ?? 0)
        if (loss > 0) {
          player.strength -= loss
          next.log = [...next.log, `${player.name} loses ${loss} Strength at end of turn`]
        }
        player.strengthLossAtEndOfTurn = 0
      } else if (localId.startsWith('orb:')) {
        if (!resolveOrbAtEndOfTurn(next, player, Number(localId.slice(4)), endTurnChoiceTarget(choice))) {
          return state
        }
      } else if (localId === 'wrath') {
        const hp = player.hp
        damagePlayer(player, 1)
        next.log = [...next.log, hp > player.hp
          ? `${player.name} takes 1 from Wrath`
          : `${player.name} blocks the bite of Wrath`]
        if (player.dead) next.log = [...next.log, `${player.name} has fallen`]
      } else if (localId.startsWith('card:')) {
        resolveHandEndTurn(next, player, localId.slice(5))
      }
    }
    if (combatIsOver(next)) break
  }

  next.phase = 'discard'
  return settle(next)
}

/** End of Turn: resolve effects, then discard every hand in chosen order. */
export function endPlayerTurn(state: CombatState, discardOrders: DiscardOrders = {}): CombatState {
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
    const hand = new Set(player.hand.map((card) => card.uid))
    if (order.length !== hand.size || new Set(order).size !== hand.size || order.some((uid) => !hand.has(uid))) {
      return prepared
    }
  }
  const next = clone(prepared)
  for (const player of next.players) {
    if (player.dead) continue
    const held = player.hand.length
    const order = discardOrders[player.id]
    const hand = order ? order.map((uid) => player.hand.find((card) => card.uid === uid)!) : player.hand
    const keep = hand
      .filter((held) => held.endTurnProtected || faceOf(cardDef(held.defId), held.upgraded).retain)
      .map((held) => held.uid)
    const piles = discardHand({ ...player, hand }, keep)
    player.draw = piles.draw
    player.hand = piles.hand.map((held) => held.endTurnProtected
      ? { ...held, endTurnProtected: undefined }
      : held)
    player.discard = piles.discard
    const discarded = held - keep.length
    if (discarded > 0) {
      next.log = [...next.log, `${player.name} discards ${discarded} at end of turn`]
    }
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
  if (state.phase !== 'enemy') return state
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
        for (let i = 0; i < (action.times ?? 1); i++) {
          if (target.dead) break
          damagePlayer(target, hitDamage(action.amount, mods, { vulnerable: vulnerableAtStart }))
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
            : blocked > 0
              ? `${target.name} blocked ${name} completely (${blocked} spent)`
              : `${name} did no damage to ${target.name}`,
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

/**
 * Evokes one orb and applies its effect.
 *
 * The board game lets you evoke ANY orb — there is no front slot and no
 * rotation (p.16) — and the atomic context carries one slot and, where needed,
 * one enemy for each evoke.
 */
function evokeOrb(state: CombatState, actor: Player, context: PlayContext): OrbType | null {
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

  const chosenTarget = context.evokeEnemyUids?.[index]
  const target = context.evokeEnemyUids
    ? livingEnemies(state).find((enemy) => enemy.uid === chosenTarget)
    : resolveEnemyTargets(state, 'enemy', context.enemyUid)[0] ?? livingEnemies(state)[0]
  if (orb === 'lightning') {
    if (!target) {
      if (livingEnemies(state).length > 0) context.invalidEvokeTarget = true
    } else damageEnemyLogged(state, target, 2, `${actor.name}'s Lightning orb`)
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1)
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  } else {
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    if (!target) {
      if (livingEnemies(state).length > 0) context.invalidEvokeTarget = true
    } else damageEnemyLogged(state, target, 3 + actor.powers.length, `${actor.name}'s Dark orb`)
  }
  return orb
}

/** Resolves one Orb's end-turn effect; each Orb is separately ordered (p.16). */
function resolveOrbAtEndOfTurn(state: CombatState, actor: Player, slot: number, targetUid?: string): boolean {
  const orb = actor.orbs[slot]
  if (orb === 'lightning') {
    const target = livingEnemies(state).find((enemy) => enemy.uid === targetUid)
    if (!target) return false
    damageEnemyLogged(state, target, 1, `${actor.name}'s Lightning orb`)
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1)
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
 * Effects resolve against their owner, targeting the first living enemy where a
 * target is needed, since an ongoing effect never stops to ask.
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
 * quietly under-performing rather than an error.
 */
export const MAX_TRIGGER_DEPTH = 8
let triggerDepth = 0

function fireTriggers(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  if (triggerDepth >= MAX_TRIGGER_DEPTH) return
  triggerDepth++
  try {
    fireTriggersInner(state, event, only, excludeUid)
  } finally {
    triggerDepth--
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
}

function triggerSources(player: Player, event: TriggerEvent, excludeUid?: string): TriggerSource[] {
  const sources: TriggerSource[] = []
  for (const [index, held] of player.relics.entries()) {
    const def = relicDef(held.defId)
    if (!triggerMatches(def.trigger, event)) continue
    sources.push({
      id: `relic:${index}`,
      trigger: def.trigger,
      effects: def.effects,
      name: `${player.name}'s ${def.name}`,
      scope: 'enemy',
      supportScope: 'self',
    })
  }
  for (const held of player.powers) {
    if (held.uid === excludeUid) continue
    const def = faceOf(cardDef(held.defId), held.upgraded)
    if (!def.trigger || !triggerMatches(def.trigger, event)) continue
    sources.push({
      id: `power:${held.uid}`,
      trigger: def.trigger,
      effects: def.effects,
      name: `${player.name}'s ${def.name}`,
      scope: def.target ?? 'enemy',
      supportScope: def.supportTarget ?? 'self',
    })
  }
  return sources
}

function resolveTriggerSource(state: CombatState, player: Player, source: TriggerSource): void {
  const target = livingEnemies(state)[0]
  const context: PlayContext = { enemyUid: target?.uid ?? null, playerId: player.id }
  for (const effect of source.effects) {
    applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
  }
}

function fireTriggersInner(
  state: CombatState,
  event: TriggerEvent,
  only?: Player,
  excludeUid?: string,
): void {
  for (const player of state.players) {
    if (player.dead) continue
    if (only && player.id !== only.id) continue

    for (const source of triggerSources(player, event, excludeUid)) {
      resolveTriggerSource(state, player, source)
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
    state.phase = 'won'
    fireTriggers(state, { kind: 'endOfCombat' })
    return state
  }
  // p.13: ONE death, not a wipe. This is a co-op game where the party stands
  // or falls together, and last-man-standing is a much easier game.
  if (state.players.some((player) => player.dead)) {
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
    players,
    enemies,
    discardedThisTurn: [],
    stanceChangedThisTurn: [],
    log: [],
  }
}

/** Spend one Miracle for one Energy during the shared Player Turn (p.17). */
export function spendMiracle(state: CombatState, playerId: string): CombatState {
  if (state.phase !== 'player') return state
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
  if (state.phase !== 'player') return state
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
    { kind: 'hit', amount: 1 },
    'enemy',
    'self',
    { enemyUid, playerId },
    'Shiv',
  )
  return settle(next)
}

/** Use and discard one held potion during the shared Player Turn (p.8, p.12). */
export function activatePotion(
  state: CombatState,
  playerId: string,
  potionId: string,
  context: PotionContext = {},
): CombatState {
  if (state.phase !== 'player') return state
  const player = findPlayer(state, playerId)
  if (!player || player.dead || !player.potions.includes(potionId)) return state
  const def = potionDef(potionId)
  const target = def.target ?? 'enemy'
  if (def.target === 'row') {
    if (!Number.isInteger(context.enemyRow) || !state.players.some((seat) => seat.row === context.enemyRow)) {
      return state
    }
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
