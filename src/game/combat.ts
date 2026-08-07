// The combat round: a shared Player Turn, then an Enemy Turn, repeating.
//
// Every exported function takes a state and returns a new one. An illegal
// action returns the SAME REFERENCE, which is how callers and the server tell
// "not allowed" from "allowed but nothing changed".
import { faceOf, cardDef } from './cards.ts'
import type { Effect, TargetScope } from './cards.ts'
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
import { drawCards, discardHand } from './piles.ts'
import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import { CAPS } from './types.ts'
import type { Enemy, Player } from './types.ts'

export type CombatPhase = 'player' | 'enemy' | 'won' | 'lost'

export type CombatState = {
  rng: RngState
  turn: number
  /** One shared die roll drives every die effect for the whole round (p.12). */
  die: number
  phase: CombatPhase
  players: Player[]
  enemies: Enemy[]
  log: string[]
}

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

/** Deals `damage` to an enemy, spending its Block first. */
function damageEnemy(enemy: Enemy, damage: number): void {
  const outcome = applyDamage(enemy.block, enemy.hp, damage)
  enemy.block = outcome.block
  enemy.hp = outcome.hp
  if (enemy.hp === 0) enemy.dead = true
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
): void {
  const mods = attackerModsOfPlayer(actor)

  switch (effect.kind) {
    case 'hit': {
      const targets = resolveEnemyTargets(state, scope, context.enemyUid)
      const times = effect.times ?? 1
      for (const target of targets) {
        // Every hit of a multi-hit is modified, but only ONE token comes off
        // after the whole thing resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        for (let i = 0; i < times; i++) {
          if (target.dead) break
          damageEnemy(target, hitDamage(effect.amount, mods, { vulnerable: vulnerableAtStart }))
        }
        if (vulnerableAtStart > 0) target.vulnerable = vulnerableAtStart - 1
      }
      return
    }
    case 'damage': {
      // Not a hit: blockable, but unmodified by Strength/Weak/Vulnerable.
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        damageEnemy(target, effect.amount)
      }
      return
    }
    case 'loseHp': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        const outcome = applyHpLoss(target.hp, effect.amount)
        target.hp = outcome.hp
        if (target.hp === 0) target.dead = true
      }
      return
    }
    case 'block': {
      for (const target of resolvePlayerTargets(state, supportScope, context.playerId, actor)) {
        target.block = gainBlock(target.block, effect.amount)
      }
      return
    }
    case 'applyVulnerable': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        target.vulnerable = gainVulnerable(target.vulnerable, effect.amount)
      }
      return
    }
    case 'applyWeak': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        target.weak = gainWeak(target.weak, effect.amount)
      }
      return
    }
    case 'gainStrength': {
      actor.strength = gainStrength(actor.strength, effect.amount)
      return
    }
    case 'poison': {
      for (const target of resolveEnemyTargets(state, scope, context.enemyUid)) {
        target.poison = gainPoison(target.poison, effect.amount, totalPoisonInPlay(state.enemies))
      }
      return
    }
    case 'draw': {
      const result = drawCards(state.rng, actor, effect.amount)
      actor.draw = result.draw
      actor.hand = result.hand
      actor.discard = result.discard
      return
    }
    case 'gainEnergy': {
      actor.energy = Math.min(CAPS.energy, actor.energy + effect.amount)
      return
    }
    case 'gainShiv': {
      actor.shivs = Math.min(CAPS.shivs, actor.shivs + effect.amount)
      return
    }
    case 'gainMiracle': {
      actor.miracles = Math.min(CAPS.miracles, actor.miracles + effect.amount)
      return
    }
    case 'enterStance': {
      // Leaving Calm grants 2 energy; entering a stance you are in is ignored.
      if (actor.stance === effect.stance) return
      if (actor.stance === 'calm') actor.energy = Math.min(CAPS.energy, actor.energy + 2)
      actor.stance = effect.stance
      return
    }
    case 'heal': {
      actor.hp = Math.min(actor.maxHp, actor.hp + effect.amount)
      return
    }
    case 'discard': {
      const chosen = (context.discardUids ?? []).slice(0, effect.amount)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      actor.discard = [...actor.discard, ...moved]
      return
    }
    case 'exhaustFromHand': {
      const chosen = (context.exhaustUids ?? []).slice(0, effect.amount)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      actor.exhaust = [...actor.exhaust, ...moved]
      return
    }
    case 'channel':
    case 'evoke':
    case 'scry':
      // Orbs and Scry are not implemented yet. Zap, Dual Cast and any Watcher
      // Scry card therefore resolve as no-ops rather than silently doing
      // something wrong; see the note in state.ts.
      return
  }
}

function resolvePlayerTargets(
  state: CombatState,
  scope: TargetScope,
  chosenId: string | null,
  actor: Player,
): Player[] {
  if (scope === 'allPlayers') return state.players.filter((player) => !player.dead)
  if (scope === 'anyPlayer') {
    const chosen = chosenId ? findPlayer(state, chosenId) : undefined
    return chosen && !chosen.dead ? [chosen] : [actor]
  }
  return [actor]
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
  if (cost > player.energy) return state

  const next = clone(state)
  const actor = findPlayer(next, playerId)
  // The player was just found in `state`, so a clone must contain them too.
  // Returning `state` here would masquerade as "illegal move" and hide a bug.
  if (!actor) throw new Error(`player ${playerId} vanished from the cloned state`)

  // The card leaves hand before resolving and belongs to no pile until cleanup,
  // which is what stops a card that draws from drawing itself (p.12).
  actor.hand = actor.hand.filter((card) => card.uid !== cardUid)
  actor.energy -= cost

  const scope: TargetScope = def.target ?? 'enemy'
  const supportScope: TargetScope = def.supportTarget ?? 'self'
  for (const effect of def.effects) {
    applyEffect(next, actor, effect, scope, supportScope, context)
  }

  if (def.exhaust) actor.exhaust = [...actor.exhaust, held]
  else if (def.type === 'power') actor.powers = [...actor.powers, held]
  else actor.discard = [...actor.discard, held]

  next.log = [...next.log, `${actor.name} played ${def.name}`]
  return settle(next)
}

/** Start of Turn: reset, draw 5, roll the shared die (p.12). */
export function startPlayerTurn(state: CombatState): CombatState {
  const next = clone(state)
  next.phase = 'player'
  next.turn += 1
  // One roll per round; every die effect this round reads this value.
  next.die = nextInt(next.rng, 6) + 1

  for (const player of next.players) {
    if (player.dead) continue
    player.energy = 3
    player.block = 0
    const result = drawCards(next.rng, player, 5)
    player.draw = result.draw
    player.hand = result.hand
    player.discard = result.discard
  }
  next.log = [...next.log, `-- turn ${next.turn} (die ${next.die}) --`]
  return next
}

/** End of Turn: end-of-turn effects, then discard every hand (p.12). */
export function endPlayerTurn(state: CombatState): CombatState {
  if (state.phase !== 'player') return state
  const next = clone(state)

  for (const player of next.players) {
    if (player.dead) continue
    // Ending your turn in Wrath costs 1 damage, and it can be blocked (p.17).
    if (player.stance === 'wrath') damagePlayer(player, 1)
    const piles = discardHand(player)
    player.draw = piles.draw
    player.hand = piles.hand
    player.discard = piles.discard
  }

  // Poison is HP loss at end of turn and ignores Block; tokens never decrement.
  for (const enemy of next.enemies) {
    if (enemy.dead || enemy.poison === 0) continue
    const outcome = applyHpLoss(enemy.hp, enemy.poison)
    enemy.hp = outcome.hp
    if (enemy.hp === 0) enemy.dead = true
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
    const def = enemyDef(enemy.defId)
    for (const action of actionsFor(def, next.die, enemy.actionIndex)) {
      applyEnemyAction(next, enemy, action)
    }
  }

  for (const enemy of next.enemies) {
    if (enemy.dead) continue
    enemy.actionIndex = advanceCube(enemyDef(enemy.defId), enemy.actionIndex)
  }

  next.phase = 'player'
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
  return state.players.filter((player) => !player.dead && player.row === enemy.row)
}

function applyEnemyAction(state: CombatState, enemy: Enemy, action: EnemyAction): void {
  const living = state.players.filter((player) => !player.dead)

  switch (action.kind) {
    case 'attack': {
      const targets = action.aoe ? living : playersInRowOf(state, enemy)
      const mods = attackerModsOfEnemy(enemy)
      for (const target of targets) {
        const vulnerableAtStart = 0 // players do not carry Vulnerable in this build
        for (let i = 0; i < (action.times ?? 1); i++) {
          if (target.dead) break
          damagePlayer(target, hitDamage(action.amount, mods, { vulnerable: vulnerableAtStart }))
        }
      }
      // One Weak token comes off after the whole action, not per hit.
      if (enemy.weak > 0) enemy.weak -= 1
      return
    }
    case 'block': {
      enemy.block = gainBlock(enemy.block, action.amount)
      return
    }
    case 'gainStrength': {
      enemy.strength = gainStrength(enemy.strength, action.amount)
      return
    }
    case 'applyWeak':
    case 'applyVulnerable': {
      // Players cannot yet carry Weak or Vulnerable; these land nowhere until
      // player-side tokens exist. Deliberately a no-op rather than a wrong guess.
      return
    }
    case 'idle':
      return
  }
}

/** Decides whether the combat has ended, and returns the state either way. */
function settle(state: CombatState): CombatState {
  if (state.players.every((player) => player.dead)) {
    state.phase = 'lost'
    return state
  }
  if (state.enemies.every((enemy) => enemy.dead)) {
    state.phase = 'won'
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
    log: [],
  }
}
