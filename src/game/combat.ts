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
import { drawCards, discardHand, scry } from './piles.ts'
import { relicDef } from './relics.ts'
import { triggerMatches } from './triggers.ts'
import type { Trigger, TriggerEvent } from './triggers.ts'
import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import { CAPS } from './types.ts'
import type { Enemy, OrbType, Player } from './types.ts'

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
): Enemy[] {
  const alive = livingEnemies(state)
  if (scope === 'allEnemies') return alive
  if (scope === 'row') {
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
  /** Player chosen for supportive effects that may target an ally. */
  playerId: string | null
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
  }
}

/** What a card counts off the board. */
function countOf(count: CountOf, actor: Player): number {
  switch (count) {
    case 'orbs':
      return actor.orbs.filter((orb) => orb !== null).length
    case 'orbTypes':
      return new Set(actor.orbs.filter((orb) => orb !== null)).size
    case 'block':
      return actor.block
    case 'strength':
      return actor.strength
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

  // A whole clause that the board can switch off, as the Weak on Go for the
  // Eyes is. Checked before the target scope is resolved, because a clause that
  // does not happen does not pick a target either.
  //
  // Conditions that read a TARGET are not usable here — there is no one target
  // yet — and the only one of those, `targetPoisoned`, is a damage bonus that
  // belongs inside an `Amount`. `verify-architecture.mjs` holds that line.
  if (effect.when && !holds(effect.when, state, actor)) return

  switch (effect.kind) {
    case 'hit': {
      const targets = resolveEnemyTargets(state, scope, context.enemyUid)
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
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        damageEnemyLogged(state, target, effect.amount, who)
      }
      return
    }
    case 'loseHp': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
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
      }
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
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        const before = target.vulnerable
        target.vulnerable = gainVulnerable(target.vulnerable, effect.amount)
        // Only when the token actually went on: at the cap nothing happened,
        // and saying otherwise tells the player a card did something it did not.
        if (target.vulnerable > before) note(`${enemyLabel(state.enemies, target)} is vulnerable`)
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
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
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
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
          applyEffect(
            state,
            target,
            { kind: 'hit', amount: 1 },
            'enemy',
            'self',
            { ...context, enemyUid },
            'Shiv',
          )
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
    case 'discard': {
      const chosen = allocate(actor, context.discardUids, effect.amount, context)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
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
      actor.exhaust = [...actor.exhaust, ...moved]
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      // Once per card exhausted, which is what the Ironclad's exhaust synergy
      // counts.
      for (let i = 0; i < moved.length; i++) fireTriggers(state, { kind: 'onExhaust' }, actor)
      return
    }
    case 'channel': {
      // Written BEFORE the channel: a full orb array forces an evoke, and that
      // evoke logs. Written afterwards, the forced evoke printed above the
      // channel that caused it.
      note(`${actor.name} channels ${effect.amount} ${effect.orb}`)
      for (let i = 0; i < effect.amount; i++) channelOrb(state, actor, effect.orb, context)
      return
    }
    case 'addDaze': {
      const cards = Array.from({ length: effect.amount }, (_, index) => ({
        uid: `daze-${state.turn}-${actor.id}-${state.log.length}-${index}`,
        defId: 'daze',
        upgraded: false,
      }))
      if (effect.pile === 'draw') actor.draw = [...cards, ...actor.draw]
      else actor.discard = [...actor.discard, ...cards]
      note(`${actor.name} gains ${effect.amount} Daze`)
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
      }
      return
    }
    case 'scry': {
      // Scry shows the top X and lets the player bin any of them; the rest go
      // back on top IN THE SAME ORDER (p.24).
      const looked = Math.min(effect.amount, actor.draw.length)
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard },
        effect.amount, context.scryDiscardUids ?? [])
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

/**
 * Effects that have to be pointed at an enemy before the card can resolve.
 *
 * `evoke` is here because an evoked Lightning or Dark orb picks a target: left
 * out, Dual Cast silently aimed at the first living enemy and the Defect could
 * not direct their biggest starter card.
 */
const ENEMY_EFFECTS = ['hit', 'damage', 'loseHp', 'applyVulnerable', 'applyWeak', 'poison', 'evoke']

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
function reachesEnemy(effect: Effect, actor: Player | undefined): boolean {
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
export function cardNeedsEnemy(def: CardDef, actor?: Player): boolean {
  if (def.type === 'power' && def.trigger) return false
  if ((def.target ?? 'enemy') === 'allEnemies') return false
  return def.effects.some((effect) => reachesEnemy(effect, actor))
}

function needsChosenEnemy(
  state: CombatState,
  def: CardDef,
  chosenUid: string | null,
  actor: Player,
): boolean {
  if (!cardNeedsEnemy(def, actor)) return false
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
  if (!def.effects.some((effect) => 'toChosen' in effect && effect.toChosen)) return false
  if (chosenId === null) return false
  if (typeof chosenId !== 'string' || chosenId.length === 0) return true
  const chosen = findPlayer(state, chosenId)
  return !chosen || chosen.dead
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
  const cost = def.cost === 'X' ? player.energy : def.cost
  const miracleOnCard = context.spendMiracle === true
  if (miracleOnCard && (
    player.miracles < 1 || player.energy !== CAPS.energy || def.cost === 'X' || cost === 0
  )) return state
  if (cost > player.energy + (miracleOnCard ? 1 : 0)) return state
  // A card that must pick an enemy but was given none would otherwise spend the
  // Energy, discard itself and do nothing. The UI never allows it, but the room
  // server hands this function messages straight off the network, so the check
  // belongs here rather than in the client.
  if (needsChosenEnemy(state, def, context.enemyUid, player)) return state
  // A co-op target can die or disconnect after the client stages the card.
  // Refuse the stale command instead of silently redirecting its support
  // effect to the caster.
  if (hasInvalidChosenPlayer(state, def, context.playerId)) return state
  // Evoking with no orbs charged the Energy, discarded the card and did
  // nothing at all — with the UI still asking which enemy to point it at.
  if (def.effects.some((effect) => effect.kind === 'evoke') && player.orbs.every((orb) => !orb)) {
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
  const resolvesOnPlay = !(def.type === 'power' && def.trigger)
  // `spentUids` and `shortfall` are this play's verdict, not the caller's
  // request, so they go on a copy. The caller's object is theirs: in the UI it
  // is assembled out of React state, and writing a scratch field back into it
  // would be a mutation from a function that is otherwise pure.
  const ctx: PlayContext = {
    ...context,
    shivEnemyUids: context.shivEnemyUids ? [...context.shivEnemyUids] : undefined,
    spentUids: new Set<string>(),
    shortfall: false,
    shivTargetIndex: 0,
  }
  if (resolvesOnPlay) {
    for (const effect of def.effects) {
      applyEffect(next, actor, effect, scope, supportScope, ctx)
    }
  }

  // Survivor reads "2 Block. Discard 1 card." — the discard is the COST, not a
  // suggestion. Off the network an empty or bogus list would otherwise buy the
  // card's effects for nothing. The whole play is resolved into a clone first,
  // so refusing it here costs the caller nothing and still signals illegality
  // the way every other refusal does: by handing back the very same reference.
  if (ctx.shortfall) return state

  if (def.exhaust) {
    actor.exhaust = [...actor.exhaust, held]
    // A card that exhausts itself is still a card being exhausted, which is
    // what Feel No Pain and Dark Embrace count.
    fireTriggers(next, { kind: 'onExhaust' }, actor)
  } else if (def.type === 'power') {
    actor.powers = [...actor.powers, held]
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

/** Resolves end-of-turn effects before players choose their discard order. */
export function beginEndPlayerTurn(state: CombatState): CombatState {
  if (state.phase !== 'player') return state
  const next = clone(state)
  fireTriggers(next, { kind: 'endOfTurn' })

  // Poison is HP loss at end of turn and ignores Block; tokens never decrement.
  // Resolved before the players' own end-of-turn damage: p.12 lets end-of-turn
  // abilities go in any order, and a party that would have won on the poison
  // tick should not lose to its own Wrath bite first.
  for (const enemy of next.enemies) {
    if (enemy.dead || enemy.poison === 0) continue
    const outcome = applyHpLoss(enemy.hp, enemy.poison)
    const name = enemyLabel(next.enemies, enemy)
    // The hit points actually lost, not the token count: an enemy on 2 HP with
    // 5 Poison loses 2, and saying "loses 5" is simply untrue.
    next.log = [...next.log, `${name} loses ${enemy.hp - outcome.hp} to Poison`]
    enemy.hp = outcome.hp
    if (enemy.hp === 0) {
      enemy.dead = true
      next.log = [...next.log, `${name} is dead`]
      triggerEnemyDeathAbility(next, enemy)
    }
  }

  for (const player of next.players) {
    if (player.dead) continue
    // Checked in TWO places, because the combat can end at either point and
    // both endings are immediate (p.13):
    //   here — a previous player's orb or bite already ended it, so this
    //   player takes no end-of-turn step at all;
    //   again below — this player's own orb ended it, so their own Wrath bite
    //   must not then land.
    // Guarding only one of the two left a mirror hole each time: first a bite
    // landing after victory, then a later player's orb reporting victory in a
    // combat a death had already lost.
    if (combatIsOver(next)) break
    // Orbs fire before the hand is discarded, and before the Wrath bite.
    resolveOrbsAtEndOfTurn(next, player)
    if (combatIsOver(next)) break
    // Ending your turn in Wrath costs 1 damage, and it can be blocked (p.17).
    // Logged, because otherwise the seat flinches with nothing to explain it.
    if (player.stance === 'wrath') {
      const hpBefore = player.hp
      damagePlayer(player, 1)
      const lost = hpBefore - player.hp
      next.log = [
        ...next.log,
        lost > 0 ? `${player.name} takes 1 from Wrath` : `${player.name} blocks the bite of Wrath`,
      ]
      if (player.dead) next.log = [...next.log, `${player.name} has fallen`]
    }
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
      .filter((held) => faceOf(cardDef(held.defId), held.upgraded).retain)
      .map((held) => held.uid)
    const piles = discardHand({ ...player, hand }, keep)
    player.draw = piles.draw
    player.hand = piles.hand
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
        const cards = Array.from({ length: action.amount }, (_, i) => ({
          uid: `daze-${state.turn}-${enemy.uid}-${target.id}-${i}`,
          defId: 'daze',
          upgraded: false,
        }))
        target.draw = [...cards, ...target.draw]
        state.log = [
          ...state.log,
          // No enemy in the box deals more than one Daze, so the plural branch
          // that used to sit here was unreachable. One card, one phrase.
          `${name} slipped a Daze into ${target.name}'s deck`,
        ]
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
): void {
  const open = actor.orbs.indexOf(null)
  if (open >= 0) {
    actor.orbs[open] = orb
    return
  }
  // A full set forces an evoke to make room (p.16). Unsaid, the evoke's line
  // appeared with nothing to explain why an orb had vanished.
  state.log = [...state.log, `${actor.name} has no free orb slot, and must evoke to make room`]
  evokeOrb(state, actor, context)
  const freed = actor.orbs.indexOf(null)
  if (freed >= 0) actor.orbs[freed] = orb
}

/**
 * Evokes one orb and applies its effect.
 *
 * The board game lets you evoke ANY orb — there is no front slot and no
 * rotation (p.16) — and `context.evokeSlots` carries that choice, which the
 * room layer forwards. The LOCAL UI does not yet collect it, so playing from
 * this client always takes the first occupied slot. That gap is listed in
 * state.ts rather than papered over here.
 */
function evokeOrb(state: CombatState, actor: Player, context: PlayContext): void {
  // The slot has to be a real array INDEX, not any property key. These values
  // arrive as JSON from a client, and `orbs['length']` was truthy — it evoked
  // a non-existent Dark orb for free damage and then assigned null to
  // `length`, truncating the array to zero slots for the rest of the combat.
  // `orbs['__proto__']` was worse: it nulled the prototype and the next call
  // threw straight out of the room layer.
  const chosen = context.evokeSlots?.find(
    (slot) =>
      Number.isInteger(slot) && slot >= 0 && slot < actor.orbs.length && actor.orbs[slot] != null,
  )
  const slot = chosen ?? actor.orbs.findIndex((orb) => orb != null)
  if (slot < 0) return
  const orb = actor.orbs[slot]
  if (!orb) return
  actor.orbs[slot] = null

  const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0] ?? livingEnemies(state)[0]
  if (orb === 'lightning') {
    if (target) damageEnemyLogged(state, target, 2, `${actor.name}'s Lightning orb`)
  } else if (orb === 'frost') {
    const before = actor.block
    grantBlock(state, actor, 1)
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  } else {
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    if (target) damageEnemyLogged(state, target, 3 + actor.powers.length, `${actor.name}'s Dark orb`)
  }
}

/**
 * End of turn, each Lightning orb deals 1 and each Frost orb grants 1 Block.
 * Dark orbs do nothing until evoked (p.16).
 */
function resolveOrbsAtEndOfTurn(state: CombatState, actor: Player): void {
  for (const orb of actor.orbs) {
    // The orbs behind the one that ended the fight never fire (p.13). The
    // caller guards around this loop; without a guard INSIDE it, a Frost orb
    // sitting after a lethal Lightning orb still handed out Block — and fired
    // its triggers — in a combat that was already over.
    if (combatIsOver(state)) return
    if (orb === 'lightning') {
      const target = livingEnemies(state)[0]
      // Named as the orb, not the player: an enemy's hit points dropping with
      // no line at all was the only silent end-of-turn effect left.
      if (target) damageEnemyLogged(state, target, 1, `${actor.name}'s Lightning orb`)
    } else if (orb === 'frost') {
      const before = actor.block
      grantBlock(state, actor, 1)
      if (actor.block > before) {
        state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
      }
    }
  }
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
  trigger: Trigger
  effects: Effect[]
  /** Named in the log, so a recurring effect is attributable. */
  name: string
  /** The card's own declared scopes, so a Power hits what it says it hits. */
  scope: TargetScope
  supportScope: TargetScope
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

    const sources: TriggerSource[] = []
    for (const held of player.relics) {
      const def = relicDef(held.defId)
      // Relics declare no scope, so they keep the defaults they always had.
      sources.push({
        trigger: def.trigger,
        effects: def.effects,
        name: `${player.name}'s ${def.name}`,
        scope: 'enemy',
        supportScope: 'self',
      })
    }
    for (const card of player.powers) {
      if (card.uid === excludeUid) continue
      const def = faceOf(cardDef(card.defId), card.upgraded)
      if (!def.trigger) continue
      // A Power carries the same target fields as any other card, and a
      // declared-but-unhonoured flag is worse than a missing one: it reads as
      // implemented. Honour them rather than assuming single-target.
      sources.push({
        trigger: def.trigger,
        effects: def.effects,
        name: `${player.name}'s ${def.name}`,
        scope: def.target ?? 'enemy',
        supportScope: def.supportTarget ?? 'self',
      })
    }

    for (const source of sources) {
      if (!triggerMatches(source.trigger, event)) continue
      const target = livingEnemies(state)[0]
      const context: PlayContext = { enemyUid: target?.uid ?? null, playerId: player.id }
      for (const effect of source.effects) {
        applyEffect(state, player, effect, source.scope, source.supportScope, context, source.name)
      }
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
