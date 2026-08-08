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
import { drawCards, discardHand, scry } from './piles.ts'
import { relicDef } from './relics.ts'
import type { RelicTrigger } from './relics.ts'
import { nextInt } from './rng.ts'
import type { RngState } from './rng.ts'
import { CAPS } from './types.ts'
import type { Enemy, OrbType, Player } from './types.ts'

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
  /** Of the cards a Scry revealed, the ones the player bins. */
  scryDiscardUids?: string[]
  /**
   * Which orb slot to evoke, when the player has a choice. The board game lets
   * you evoke ANY orb, unlike the video game's fixed front slot (p.16).
   */
  evokeSlots?: number[]
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
      // The attacker's own Weak is spent by attacking, exactly as an enemy's is
      // (p.24). One token per attack, however many targets or hits it had.
      if (targets.length > 0 && actor.weak > 0) actor.weak -= 1
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
    case 'channel': {
      for (let i = 0; i < effect.amount; i++) channelOrb(state, actor, effect.orb, context)
      return
    }
    case 'evoke': {
      for (let i = 0; i < effect.times; i++) evokeOrb(state, actor, context)
      return
    }
    case 'scry': {
      // Scry shows the top X and lets the player bin any of them; the rest go
      // back on top IN THE SAME ORDER (p.24).
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard },
        effect.amount, context.scryDiscardUids ?? [])
      actor.draw = piles.draw
      actor.discard = piles.discard
      return
    }
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

  // The Start of Turn phases run in the order the rulebook prints them (p.12):
  // Reset, Draw, Roll, then start-of-turn abilities. The order matters even
  // though the roll is independent of the draw today, because it decides which
  // RNG values each step consumes — swapping them changes every seeded replay.
  for (const player of next.players) {
    if (player.dead) continue
    player.energy = 3
    player.block = 0
    const result = drawCards(next.rng, player, 5)
    player.draw = result.draw
    player.hand = result.hand
    player.discard = result.discard
  }

  // One roll per round; every die effect this round reads this value.
  next.die = nextInt(next.rng, 6) + 1

  // Start-of-combat abilities only fire on turn 1 (p.12).
  if (next.turn === 1) fireRelics(next, 'startOfCombat')
  fireRelics(next, 'startOfTurn')
  // Die relics fire after the roll, during Start of Turn (p.19).
  fireRelics(next, 'dieRelic')

  next.log = [...next.log, `-- turn ${next.turn} (die ${next.die}) --`]
  return next
}

/** End of Turn: end-of-turn effects, then discard every hand (p.12). */
export function endPlayerTurn(state: CombatState): CombatState {
  if (state.phase !== 'player') return state
  const next = clone(state)
  fireRelics(next, 'endOfTurn')

  for (const player of next.players) {
    if (player.dead) continue
    // Orbs fire before the hand is discarded, and before the Wrath bite.
    resolveOrbsAtEndOfTurn(next, player)
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
        // Every hit is modified, but only one Vulnerable token comes off after
        // the whole action resolves (p.14).
        const vulnerableAtStart = target.vulnerable
        for (let i = 0; i < (action.times ?? 1); i++) {
          if (target.dead) break
          damagePlayer(target, hitDamage(action.amount, mods, { vulnerable: vulnerableAtStart }))
        }
        if (vulnerableAtStart > 0) target.vulnerable = vulnerableAtStart - 1
      }
      // One Weak token comes off after the whole action, not per hit — and only
      // if the action actually attacked something. An enemy swinging at an
      // empty row has not attacked (p.24), same rule as the player side.
      if (targets.length > 0 && enemy.weak > 0) enemy.weak -= 1
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
    case 'applyWeak': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        target.weak = gainWeak(target.weak, action.amount)
      }
      return
    }
    case 'applyVulnerable': {
      for (const target of action.aoe ? living : playersInRowOf(state, enemy)) {
        target.vulnerable = gainVulnerable(target.vulnerable, action.amount)
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
  evokeOrb(state, actor, context)
  const freed = actor.orbs.indexOf(null)
  if (freed >= 0) actor.orbs[freed] = orb
}

/**
 * Evokes one orb and applies its effect. The board game lets you evoke ANY orb;
 * there is no front slot and no rotation (p.16). Without an explicit choice the
 * first occupied slot is used, which keeps a card playable without a prompt.
 */
function evokeOrb(state: CombatState, actor: Player, context: PlayContext): void {
  const chosen = context.evokeSlots?.find((slot) => actor.orbs[slot] != null)
  const slot = chosen ?? actor.orbs.findIndex((orb) => orb != null)
  if (slot < 0) return
  const orb = actor.orbs[slot]
  if (!orb) return
  actor.orbs[slot] = null

  const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0] ?? livingEnemies(state)[0]
  if (orb === 'lightning') {
    if (target) damageEnemy(target, 2)
  } else if (orb === 'frost') {
    actor.block = gainBlock(actor.block, 1)
  } else {
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    if (target) damageEnemy(target, 3 + actor.powers.length)
  }
}

/**
 * End of turn, each Lightning orb deals 1 and each Frost orb grants 1 Block.
 * Dark orbs do nothing until evoked (p.16).
 */
function resolveOrbsAtEndOfTurn(state: CombatState, actor: Player): void {
  for (const orb of actor.orbs) {
    if (orb === 'lightning') {
      const target = livingEnemies(state)[0]
      if (target) damageEnemy(target, 1)
    } else if (orb === 'frost') {
      actor.block = gainBlock(actor.block, 1)
    }
  }
}


/**
 * Fires every relic whose trigger matches. Relics are the first users of the
 * trigger machinery that Powers will also need — the shape here is deliberately
 * the one a Power trigger will reuse.
 *
 * A relic's effects resolve against the owner, targeting the first living enemy
 * where a target is required, since a relic never asks the player to choose.
 */
function fireRelics(state: CombatState, when: RelicTrigger['kind']): void {
  for (const player of state.players) {
    if (player.dead) continue
    for (const held of player.relics) {
      const def = relicDef(held.defId)
      const trigger = def.trigger
      if (trigger.kind !== when) continue
      // Die relics only fire on a matching roll (p.19).
      if (trigger.kind === 'dieRelic' && !trigger.faces.includes(state.die)) continue

      const target = livingEnemies(state)[0]
      const context: PlayContext = { enemyUid: target?.uid ?? null, playerId: player.id }
      for (const effect of def.effects) {
        applyEffect(state, player, effect, 'enemy', 'self', context)
      }
    }
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
    fireRelics(state, 'endOfCombat')
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
