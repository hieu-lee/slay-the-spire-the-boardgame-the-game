// Defect Orb mechanics: channelling, evoking, end-of-turn passives, target
// staging, and orb-domain effect clauses.
//
// Cycle-free helper module below `effects.ts`: effects-layer mutations
// (`applyEffect`, `damageEnemyLogged`, `grantBlock`) are supplied as callbacks.
import {
  clone,
  combatIsOver,
  enemyLabel,
  findPlayer,
  lightningDamageTargets,
  lightningRowTarget,
  lightningTargetOptions,
  lightningTargetsRows,
  livingEnemies,
  orbEndTurnAmount,
  resolveEnemyTargets,
} from './board.ts'
import { addPresentationEvent } from './presentation.ts'
import { amountOf, evokePlan } from './queries.ts'
import { discardTopLine, takeDiscardTop } from './slayer.ts'
import type { CombatState, PendingTrigger, PlayContext } from './types.ts'
import type { CardDef, Effect, TargetScope } from '../cards.ts'
import type { Enemy, OrbType, Player } from '../types.ts'

export interface OrbResolutionCallbacks {
  damageEnemyLogged: (
    state: CombatState,
    enemy: Enemy,
    damage: number,
    source?: string,
    actor?: Player,
  ) => void
  grantBlock: (
    state: CombatState,
    target: Player,
    amount: number,
    pendingTriggers?: PendingTrigger[],
  ) => void
}

export interface OrbEffectCallbacks extends OrbResolutionCallbacks {
  applyEffect: (
    state: CombatState,
    actor: Player,
    effect: Effect,
    scope: TargetScope,
    supportScope: TargetScope,
    context: PlayContext,
    source?: string,
    deferWeakSpend?: boolean,
    deferVulnerableSpend?: boolean,
  ) => void
}

const ORB_EFFECT_KIND_LIST = [
  'channel',
  'channelDieOrb',
  'evoke',
  'evokeAll',
  'recurseOrb',
  'fission',
  'removeAllOrbs',
  'removeOrbsForDiscardTop',
  'gainOrbSlots',
  'gainOrbEvokeBonus',
  'gainDarkOrbEvokeBonus',
  'gainOrbEndTurnBonus',
  'gainLightningEndTurnBonus',
  'lightningTargetsRow',
  'triggerOrbEndTurn',
] as const satisfies readonly Effect['kind'][]

export type OrbEffect = Extract<Effect, { kind: (typeof ORB_EFFECT_KIND_LIST)[number] }>

const ORB_EFFECT_KINDS: ReadonlySet<string> = new Set(ORB_EFFECT_KIND_LIST)

export function isOrbEffect(effect: Effect): effect is OrbEffect {
  return ORB_EFFECT_KINDS.has(effect.kind)
}

/**
 * Channels an orb into any OPEN slot. If every slot is full, an orb of the
 * player's choice is evoked first and the new one takes its place (p.16).
 * Running out of orb cubes is not modelled: the slots are the limit here.
 */
export function channelOrb(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  context: PlayContext,
  callbacks: OrbResolutionCallbacks,
): boolean {
  if (combatIsOver(state)) return false
  let open = actor.orbs.indexOf(null)
  // A full set forces an evoke to make room (p.16). Unsaid, the evoke's line
  // appeared with nothing to explain why an orb had vanished.
  if (open < 0) {
    state.log = [...state.log, `${actor.name} has no free orb slot, and must evoke to make room`]
    evokeOrb(state, actor, context, callbacks)
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

export function applyOrbEvokeEffect(
  state: CombatState,
  actor: Player,
  orb: OrbType,
  chosenTarget: string | null | undefined,
  callbacks: OrbResolutionCallbacks,
  sourceCardId?: string,
  pendingTriggers?: PendingTrigger[],
): boolean {
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, chosenTarget, sourceCardId)
    if (!targets) return false
    for (const target of targets) {
      callbacks.damageEnemyLogged(
        state,
        target,
        actor.damageDealtZeroThisTurn ? 0 : 2 + (actor.orbEvokeBonus ?? 0),
        `${actor.name}'s Lightning orb`,
        actor,
      )
    }
  } else if (orb === 'frost') {
    const before = actor.block
    callbacks.grantBlock(state, actor, 1 + (actor.orbEvokeBonus ?? 0), pendingTriggers)
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
  } else {
    const target = livingEnemies(state).find((enemy) => enemy.uid === chosenTarget)
    if (!target) return false
    // Dark: 3 damage plus 1 for each Power in play. That bonus is fixed at evoke
    // time and is not boosted by card effects (rulebook FAQ, p.18).
    callbacks.damageEnemyLogged(
      state,
      target,
      actor.damageDealtZeroThisTurn ? 0 :
        3 + actor.powers.length + (actor.orbEvokeBonus ?? 0) + (actor.darkOrbEvokeBonus ?? 0),
      `${actor.name}'s Dark orb`,
      actor,
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
export function evokeOrb(
  state: CombatState,
  actor: Player,
  context: PlayContext,
  callbacks: OrbResolutionCallbacks,
  times = 1,
): OrbType | null {
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
    const presentedTargets = orb === 'lightning'
      ? lightningDamageTargets(state, actor, chosenTarget, context.sourceCardId) ?? []
      : orb === 'dark'
        ? livingEnemies(state).filter((enemy) => enemy.uid === chosenTarget)
        : []
    const beforeEnemies = new Map(presentedTargets.map((enemy) =>
      [enemy.uid, [enemy.hp, enemy.block, enemy.dead] as const]))
    const blockBefore = actor.block
    if (applyOrbEvokeEffect(
      state,
      actor,
      orb,
      chosenTarget,
      callbacks,
      context.sourceCardId,
      context.sourceCardId ? context.pendingTriggers : undefined,
    )) {
      const enemyIds = presentedTargets.filter((enemy) => {
        const before = beforeEnemies.get(enemy.uid)!
        return enemy.hp !== before[0] || enemy.block !== before[1] || enemy.dead !== before[2]
      }).map((enemy) => enemy.uid)
      if (enemyIds.length === 0 && actor.block <= blockBefore) continue
      addPresentationEvent(state, {
        kind: 'orb', orb, actorId: actor.id, sourceId: 'orb-evoke', enemyIds, playerIds: [],
      })
    } else if (livingEnemies(state).length > 0) context.invalidEvokeTarget = true
  }
  return orb
}

/**
 * Resolves one Orb's end-turn effect; each Orb is separately ordered (p.16).
 *
 * A passive orb used to change the board with no `presentationEvent` at all —
 * every OTHER source of damage or Block gets one, so this was the one place a
 * player watched numbers move with no lightning bolt, no glow, nothing marking
 * which orb had just gone off. `sourceId: 'orb-end-turn'` is distinct from
 * channelling's `'orb-channel'` so the two can be styled differently
 * (CombatScreen staggers same-turn orbs by this sourceId) without conflating
 * "I just channelled this" with "this just fired on its own".
 */
export function resolveOrbAtEndOfTurn(
  state: CombatState,
  actor: Player,
  slot: number,
  callbacks: OrbResolutionCallbacks,
  targetUid?: string,
): boolean {
  const orb = actor.orbs[slot]
  if (orb === 'lightning') {
    const targets = lightningDamageTargets(state, actor, targetUid)
    if (!targets) return false
    // Biased Cognition's -1 can take the printed 1 to nothing; nothing is dealt.
    if (orbEndTurnAmount(actor, orb) <= 0) return true
    const changed: string[] = []
    for (const target of targets) {
      const before = [target.hp, target.block, target.dead]
      callbacks.damageEnemyLogged(
        state,
        target,
        actor.damageDealtZeroThisTurn ? 0 : orbEndTurnAmount(actor, orb),
        `${actor.name}'s Lightning orb`,
        actor,
      )
      if (target.hp !== before[0] || target.block !== before[1] || target.dead !== before[2]) {
        changed.push(target.uid)
      }
    }
    if (changed.length > 0) {
      addPresentationEvent(state, {
        kind: 'orb', orb, actorId: actor.id, sourceId: 'orb-end-turn',
        enemyIds: changed, playerIds: [],
      })
    }
  } else if (orb === 'frost') {
    const before = actor.block
    // At 0 (Biased Cognition) `grantBlock` gains nothing and fires no Block trigger.
    callbacks.grantBlock(state, actor, orbEndTurnAmount(actor, orb))
    if (actor.block > before) {
      state.log = [...state.log, `${actor.name}'s Frost orb gives ${actor.block - before} Block`]
    }
    if (actor.block > before) {
      addPresentationEvent(state, {
        kind: 'orb', orb, actorId: actor.id, sourceId: 'orb-end-turn',
        enemyIds: [], playerIds: [],
      })
    }
  }
  return true
}

/** Next legal target after applying every already-staged Evoke in sequence. */
export function evokeTargetProgress(
  def: CardDef,
  state: CombatState,
  actor: Player,
  slots: readonly number[],
  targets: readonly (string | null | undefined)[],
  callbacks: OrbResolutionCallbacks,
  mode?: number,
  energySpent = 0,
): { index: number; options: { uid: string; label: string }[]; complete: boolean } {
  const chosen = evokePlan(def, actor, slots, state.die, mode, energySpent).chosen
  const simulation = clone(state)
  const simulationActor = findPlayer(simulation, actor.id)
  if (!simulationActor) return { index: 0, options: [], complete: false }
  for (let index = 0; index < chosen.length; index++) {
    if (combatIsOver(simulation)) return { index, options: [], complete: true }
    const orb = chosen[index]!
    const target = targets[index]
    if (orb === 'frost') {
      if (target !== null) return { index, options: [], complete: false }
      continue
    }
    if (livingEnemies(simulation).length === 0) {
      return { index, options: [], complete: true }
    }
    const options = orb === 'lightning'
      ? lightningTargetOptions(simulation, simulationActor, def.id)
      : livingEnemies(simulation).map((enemy) => ({
        uid: enemy.uid, label: enemyLabel(simulation.enemies, enemy),
      }))
    if (typeof target !== 'string' || !options.some((option) => option.uid === target)) {
      return { index, options, complete: false }
    }
    if (!applyOrbEvokeEffect(simulation, simulationActor, orb, target, callbacks, def.id)) {
      return { index, options, complete: false }
    }
  }
  return { index: chosen.length, options: [], complete: true }
}

export function applyOrbEffect(
  state: CombatState,
  actor: Player,
  effect: OrbEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  callbacks: OrbEffectCallbacks,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }
  const noteAt = (at: number, text: string) => {
    const line = source ? `${source}: ${text}` : text
    state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
  }

  switch (effect.kind) {
    case 'channel': {
      // Reserve the line's position before forced evokes log, but write it only
      // after an Orb was really placed: a lethal forced evoke ends combat first.
      const at = state.log.length
      let channeled = 0
      for (let i = 0; i < amountOf(effect.amount, state, actor, undefined, context); i++) {
        if (channelOrb(state, actor, effect.orb, context, callbacks)) channeled += 1
        if (combatIsOver(state)) break
      }
      if (channeled > 0) noteAt(at, `${actor.name} channels ${channeled} ${effect.orb}`)
      return
    }
    case 'channelDieOrb': {
      const orb: OrbType = state.die <= 2 ? 'lightning' : state.die <= 4 ? 'frost' : 'dark'
      const at = state.log.length
      if (channelOrb(state, actor, orb, context, callbacks)) noteAt(at, `${actor.name} channels 1 ${orb}`)
      return
    }
    case 'removeOrbsForDiscardTop': {
      // Creative AI needs a real Orb to remove (author FAQ) and a real card to
      // return; Creative AI+ removes one Orb per returned card.
      const slots = context.orbSlots ?? []
      const count = slots.length
      if (count < 1 || (!effect.anyNumber && count !== 1) || count > actor.discard.length ||
        new Set(slots).size !== count ||
        slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= actor.orbs.length || actor.orbs[slot] == null)) {
        context.invalidRecoverChoice = true
        return
      }
      for (const slot of slots) actor.orbs[slot] = null
      note(`${actor.name} removes ${count} Orb${count === 1 ? '' : 's'}`)
      note(discardTopLine(actor, takeDiscardTop(actor, count, 'hand', false), 'hand'))
      return
    }
    case 'evokeAll': {
      if (actor.orbs.every((orb) => orb == null)) {
        note(`${actor.name} has no orb to evoke`)
        return
      }
      // Each Orb leaves once and applies its Evoke `times` times; the context's
      // evoke slots fix the order, so every Lightning/Dark application picks
      // its own target exactly as a repeated Dual Cast does.
      while (actor.orbs.some((orb) => orb != null)) {
        if (!evokeOrb(state, actor, context, callbacks, effect.times) || combatIsOver(state)) return
      }
      return
    }
    case 'evoke': {
      const times = amountOf(effect.times, state, actor, undefined, context)
      if (times > 0 && actor.orbs.every((orb) => orb == null)) note(`${actor.name} has no orb to evoke`)
      if (times > 0) evokeOrb(state, actor, context, callbacks, times)
      return
    }
    case 'recurseOrb': {
      const orb = evokeOrb(state, actor, context, callbacks)
      if (combatIsOver(state)) return
      if (orb) {
        note(`${actor.name} channels 1 ${orb}`)
        channelOrb(state, actor, orb, context, callbacks)
      }
      return
    }
    case 'fission': {
      const count = actor.orbs.filter((orb) => orb !== null).length
      if (effect.evoke) {
        for (let index = 0; index < count; index++) {
          evokeOrb(state, actor, context, callbacks)
          if (combatIsOver(state)) return
        }
      } else {
        actor.orbs = actor.orbs.map(() => null)
        if (count > 0) note(`${actor.name} removes ${count} Orbs`)
      }
      callbacks.applyEffect(state, actor, { kind: 'gainEnergy', amount: count }, scope, supportScope, context, source)
      callbacks.applyEffect(state, actor, { kind: 'draw', amount: count }, scope, supportScope, context, source)
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
      // Slayer Pack: Biased Cognition's bonus is negative, so print the sign as given.
      note(`${actor.name}'s Orb end-of-turn effects get ${effect.amount < 0 ? effect.amount : `+${effect.amount}`}`)
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
  }
}
