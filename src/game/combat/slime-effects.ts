// Downfall Slime Boss combat mechanics: Slime Commands, Growth, Vigor, and
// Slime Boss effect clauses.
//
// Cycle-free helper module below `effects.ts`: effects-layer mutations
// (`applyEffect`, `drawInto`, `exhaustCards`) are supplied as callbacks.
import { combatIsOver, livingEnemies } from './board.ts'
import { forgetRetain } from './pieces.ts'
import { addPresentationEvent, presentationTargets } from './presentation.ts'
import { amountOf, cardHasRetain, cardIsPlayable, effectiveCombatCardDef, reachesEnemy } from './queries.ts'
import { queuedTriggers } from './trigger-queries.ts'
import { markTurnEffect } from './turn-presentation.ts'
import type { CombatState, PendingTrigger, PlayContext } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { Effect, TargetScope } from '../cards.ts'
import { gainStrength } from '../damage.ts'
import { commandSlime, gainSlimeVigor, growSlime, previewSlimeCommand, slimeDef } from '../downfall/slime-boss.ts'
import { shuffle } from '../rng.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Player } from '../types.ts'

export interface SlimeCommandCallbacks {
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

export interface SlimeEffectCallbacks extends SlimeCommandCallbacks {
  drawInto: (
    state: CombatState,
    actor: Player,
    amount: number,
    pendingTriggers?: PendingTrigger[],
  ) => CardInstance[]
  exhaustCards: (
    state: CombatState,
    actor: Player,
    cards: readonly CardInstance[],
    context?: PlayContext,
  ) => void
}

const SLIME_EFFECT_KIND_LIST = [
  'growSlime',
  'commandSlime',
  'gainSlimeVigor',
  'discountPartyAttack',
  'discountNextPowerOrSlime',
  'tapSlime',
  'rainOfGoop',
  'blockIfRetain',
  'vulnerableIfTackle',
  'gainEnergyIfExhaustCost',
  'growIfExhaustCost',
  'overexert',
  'replicateSlime',
] as const satisfies readonly Effect['kind'][]

export type SlimeEffect = Extract<Effect, { kind: (typeof SLIME_EFFECT_KIND_LIST)[number] }>

const SLIME_EFFECT_KINDS: ReadonlySet<string> = new Set(SLIME_EFFECT_KIND_LIST)

export function isSlimeEffect(effect: Effect): effect is SlimeEffect {
  return SLIME_EFFECT_KINDS.has(effect.kind)
}

/** Commands one Slime, consuming its own target without reusing a sibling Command's choice. */
export function resolveSlimeCommand(
  state: CombatState,
  actor: Player,
  slime: Player['slimes'][number],
  context: PlayContext,
  callbacks: SlimeCommandCallbacks,
  source = slimeDef(slime).name,
): boolean {
  const preview = previewSlimeCommand(slime)
  if (!preview) return false
  const needsEnemy = preview.scope !== 'allEnemies' && preview.effects.some((effect) => reachesEnemy(effect, actor))
  const at = context.slimeEnemyChoiceIndex ?? 0
  const enemyUid = needsEnemy
    ? context.slimeEnemyUids === undefined ? context.enemyUid : context.slimeEnemyUids[at]
    : context.enemyUid
  if (needsEnemy && context.slimeEnemyUids !== undefined) context.slimeEnemyChoiceIndex = at + 1
  if (needsEnemy && !livingEnemies(state).some((enemy) => enemy.uid === enemyUid)) {
    return false
  }
  const command = commandSlime(slime)!
  const targets = presentationTargets(
    state,
    actor.id,
    command.effects.some((effect) => reachesEnemy(effect, actor)) ? command.scope : 'self',
    'self',
    { enemyUid: enemyUid ?? null },
  )
  const enemyIds = enemyUid && targets.enemyIds.includes(enemyUid)
    ? [enemyUid, ...targets.enemyIds.filter((uid) => uid !== enemyUid)]
    : targets.enemyIds
  // The Slime's damage belongs to its own Command beat, not to the staged strike of the card that Commanded it.
  const cardEvent = state.presentationEvents?.at(-1)
  const cardHpLoss = cardEvent?.enemyHpLoss
  for (const effect of command.effects) {
    callbacks.applyEffect(state, actor, effect, command.scope, 'self', {
      ...context,
      enemyUid: enemyUid ?? null,
      slimeUids: [slime.card.uid],
      slimeChoiceIndex: 0,
      slimeCommand: true,
    }, source)
    if (combatIsOver(state)) break
  }
  if (cardEvent && cardHpLoss) cardEvent.enemyHpLoss = cardHpLoss
  const animationCounts = (context.slimeAnimationCounts ??= {})
  const animationIndex = animationCounts[slime.card.uid] ?? 0
  animationCounts[slime.card.uid] = animationIndex + 1
  addPresentationEvent(state, {
    kind: 'slime',
    actorId: actor.id,
    sourceId: slime.card.defId,
    slimeUid: slime.card.uid,
    upgraded: slime.card.upgraded,
    animationIndex,
    ...targets,
    enemyIds,
  })
  return true
}

/** Resolve Slime triggers only after the current card or triggered ability finishes. */
export function resolvePendingSlimeCommands(
  state: CombatState,
  actor: Player,
  context: PlayContext,
  callbacks: SlimeCommandCallbacks,
): void {
  for (const uid of context.pendingSlimeCommandUids ?? []) {
    if (combatIsOver(state)) break
    const slime = actor.slimes.find((candidate) => candidate.card.uid === uid)
    if (slime) resolveSlimeCommand(state, actor, slime, context, callbacks)
  }
  context.pendingSlimeCommandUids = []
}

export function growSlimeWithTriggers(
  state: CombatState,
  actor: Player,
  slime: Player['slimes'][number],
  amount: number,
  context: PlayContext,
  callbacks: SlimeCommandCallbacks,
): number {
  const grown = growSlime(slime, amount)
  if (grown > 0) markTurnEffect(context, 'buff', { actor: true })
  for (let step = 0; step < grown; step++) for (const leech of actor.slimes) {
    if (slimeDef(leech).slimeTrigger !== 'onGrow') continue
    if (context.pendingSlimeCommandUids) context.pendingSlimeCommandUids.push(leech.card.uid)
    else if (!combatIsOver(state)) resolveSlimeCommand(state, actor, leech, context, callbacks)
  }
  return grown
}

function grantSlimeVigor(
  state: CombatState,
  actor: Player,
  slime: Player['slimes'][number],
  amount: number,
  temporary: boolean | undefined,
  commandAfter: boolean,
  context: PlayContext,
  callbacks: SlimeCommandCallbacks,
): number {
  const gained = gainSlimeVigor(slime, amount, temporary)
  const vigorTrigger = gained > 0 && slimeDef(slime).slimeTrigger === 'onGainVigor' &&
    !slime.vigorTriggerUsedThisTurn
  if (vigorTrigger) slime.vigorTriggerUsedThisTurn = true
  if (commandAfter && !combatIsOver(state)) resolveSlimeCommand(state, actor, slime, context, callbacks)
  if (vigorTrigger && !combatIsOver(state)) resolveSlimeCommand(state, actor, slime, context, callbacks)
  return gained
}

export function applySlimeEffect(
  state: CombatState,
  actor: Player,
  effect: SlimeEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  callbacks: SlimeEffectCallbacks,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'growSlime': {
      const choices = context.slimeUids ?? (context.sourcePowerUid && actor.slimes?.[0]
        ? [actor.slimes[0].card.uid] : [])
      const cursor = context.slimeChoiceIndex ?? 0
      const count = effect.upToDifferent ?? 1
      const picked = effect.upToDifferent === undefined ? choices.slice(cursor, cursor + 1) : choices.slice(cursor, cursor + count)
      if ((effect.upToDifferent === undefined && picked.length === 0) ||
        new Set(picked).size !== picked.length) {
        context.invalidSlimeChoice = true
        return
      }
      for (const uid of picked) {
        const slime = actor.slimes?.find((candidate) => candidate.card.uid === uid)
        if (!slime) {
          context.invalidSlimeChoice = true
          return
        }
        if (combatIsOver(state)) break
        const grown = growSlimeWithTriggers(
          state, actor, slime, effect.upToDifferent === undefined ? effect.amount : 1, context, callbacks,
        )
        if (grown > 0) note(`${slimeDef(slime).name} grows to level ${slime.level}`)
        if (effect.commandAfter && !combatIsOver(state)) resolveSlimeCommand(state, actor, slime, context, callbacks)
      }
      context.slimeChoiceIndex = cursor + picked.length
      return
    }
    case 'commandSlime': {
      const choices = context.slimeUids ?? (context.sourcePowerUid && actor.slimes?.[0]
        ? [actor.slimes[0].card.uid] : [])
      const cursor = context.slimeChoiceIndex ?? 0
      const repeat = amountOf(effect.amount, state, actor, undefined, context)
      let picked: string[]
      if (effect.all) picked = (actor.slimes ?? []).map((slime) => slime.card.uid)
      else if (effect.same) picked = choices.slice(cursor, cursor + 1)
      else if (effect.upToDifferent === 99) picked = choices.slice(cursor, cursor + repeat)
      else if (effect.upToDifferent !== undefined) picked = choices.slice(cursor, cursor + effect.upToDifferent)
      else picked = choices.slice(cursor, cursor + 1)
      if ((!effect.all && effect.upToDifferent === undefined && picked.length === 0) ||
        new Set(picked).size !== picked.length ||
        (effect.upToDifferent === 99 && picked.length !== repeat)) {
        context.invalidSlimeChoice = true
        return
      }
      for (const uid of picked) {
        if (combatIsOver(state)) break
        const slime = actor.slimes?.find((candidate) => candidate.card.uid === uid)
        if (!slime) {
          context.invalidSlimeChoice = true
          return
        }
        const times = effect.same ? repeat : 1
        for (let index = 0; index < times; index++) {
          if (combatIsOver(state)) break
          const before = slime.commandsThisTurn
          const targetCursor = context.slimeEnemyChoiceIndex ?? 0
          if (!resolveSlimeCommand(state, actor, slime, context, callbacks)) {
            // Earlier Commands can kill a prevalidated target. Skip it without
            // spending this Slime's Command; unknown targets still reject atomically.
            const targetUid = context.slimeEnemyUids?.[targetCursor] ?? context.enemyUid
            if (previewSlimeCommand(slime)) {
              if (state.enemies.some((enemy) => enemy.uid === targetUid && enemy.dead)) continue
              context.invalidSlimeChoice = true
            }
            break
          }
          note(`${actor.name} Commands ${slimeDef(slime).name} (level ${slime.level})`)
          if (slime.commandsThisTurn === before) break
        }
      }
      if (!effect.all) context.slimeChoiceIndex = cursor + picked.length
      return
    }
    case 'gainSlimeVigor': {
      const cursor = context.slimeChoiceIndex ?? 0
      const uid = context.slimeUids?.[cursor]
      const slime = actor.slimes?.find((candidate) => candidate.card.uid === uid)
      if (!slime) {
        context.invalidSlimeChoice = true
        return
      }
      const gained = grantSlimeVigor(state, actor, slime, effect.amount, effect.temporary,
        effect.commandAfter === true, context, callbacks)
      context.slimeChoiceIndex = cursor + 1
      if (gained > 0) note(`${slimeDef(slime).name} gains ${gained} Vigor`)
      return
    }
    case 'discountPartyAttack':
      state.partyAttackDiscount = true
      for (const player of state.players.filter((candidate) => !candidate.dead)) {
        player.freeAttacksThisTurn = (player.freeAttacksThisTurn ?? 0) + 1
      }
      note('The next Attack played by any player costs 0')
      return
    case 'discountNextPowerOrSlime':
      actor.nextPowerOrSlimeDiscount = effect.amount
      return
    case 'tapSlime': {
      const cursor = context.slimeChoiceIndex ?? 0
      const uid = context.slimeUids?.[cursor]
      const slime = actor.slimes?.find((candidate) => candidate.card.uid === uid)
      if (!slime) {
        context.invalidSlimeChoice = true
        return
      }
      context.slimeChoiceIndex = cursor + 1
      callbacks.drawInto(state, actor, slime.level)
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + slime.level)
      note(`${actor.name} taps ${slimeDef(slime).name}, draws ${slime.level}, and gains ${actor.energy - before} Energy`)
      return
    }
    case 'rainOfGoop': {
      if (!context.sourcePowerUid) {
        context.sourceCounter = (context.energySpent ?? 0) + effect.bonus
        note(`${actor.name} places ${context.sourceCounter} Vigor on Rain of Goop`)
        return
      }
      const held = actor.powers.find((power) => power.uid === context.sourcePowerUid)
      if (!held) return
      if ((held.counter ?? 0) > 0) {
        const uid = context.slimeUids?.[0]
        const slime = actor.slimes?.find((candidate) => candidate.card.uid === uid)
        const before = slime?.vigor ?? actor.strength
        if (slime) grantSlimeVigor(state, actor, slime, 1, false, false, context, callbacks)
        else actor.strength = gainStrength(actor.strength, 1)
        held.counter = (held.counter ?? 0) - 1
        if ((slime?.vigor ?? actor.strength) > before) markTurnEffect(context, 'strength', { actor: true })
      }
      if ((held.counter ?? 0) === 0) {
        actor.powers = actor.powers.filter((power) => power.uid !== held.uid)
        held.counter = undefined
        callbacks.exhaustCards(state, actor, [held])
        note(`${actor.name} exhausts Rain of Goop`)
        markTurnEffect(context, 'exhaust', { actor: true })
      }
      return
    }
    case 'blockIfRetain':
      if (actor.hand.some((held) => cardHasRetain(actor, held))) {
        callbacks.applyEffect(state, actor, { kind: 'block', amount: effect.amount }, scope, supportScope, context, source)
      }
      return
    case 'vulnerableIfTackle':
      if (actor.hand.some((card) => cardDef(card.defId).name.includes('Tackle'))) {
        callbacks.applyEffect(state, actor, { kind: 'applyVulnerable', amount: effect.amount }, scope, supportScope, context, source)
      }
      return
    case 'gainEnergyIfExhaustCost':
      if (context.exhaustedCardCost !== 'X' && (context.exhaustedCardCost ?? -1) >= effect.minimum) {
        actor.energy = Math.min(CAPS.energy, actor.energy + effect.amount)
      }
      return
    case 'growIfExhaustCost':
      if (context.exhaustedCardCost !== 'X' && (context.exhaustedCardCost ?? -1) >= effect.minimum) {
        callbacks.applyEffect(state, actor, { kind: 'growSlime', amount: 1 }, scope, supportScope, context, source)
      }
      return
    case 'overexert': {
      const requested = context.searchDrawUids ?? []
      const eligible = actor.hand.filter((card) => {
        const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
        return cardIsPlayable(def, state, actor) && (def.minimumX ?? 0) === 0
      })
      if (requested.length !== Math.min(1, eligible.length) ||
        requested.some((uid) => !eligible.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = eligible.find((card) => card.uid === requested[0])
      if (!chosen) return
      const chosenDef = effectiveCombatCardDef(faceOf(cardDef(chosen.defId), chosen.upgraded), actor.guardianMode)
      actor.hand = actor.hand.filter((card) => card.uid !== chosen.uid)
      context.doppelgangerCopy = forgetRetain(chosen)
      context.queuedCopySource = 'Overexert'
      context.queuedCopyVirtualOnly = false
      const modePending = actor.guardianMode === null && chosenDef.guardian?.printedType === '???'
      context.queuedCopyTwice = !modePending && chosenDef.type === 'attack'
      context.queuedCopyTwiceIfAttack = modePending
      context.queuedCopyForcedExhaust = false
      context.queuedCopySources = []
      note(`${actor.name} will play ${chosenDef.name}${!modePending && chosenDef.type === 'attack' ? ' twice' : ''} for 0 Energy`)
      return
    }
    case 'replicateSlime': {
      const requested = context.searchDrawUids ?? []
      const eligible = actor.draw.filter((card) => cardDef(card.defId).cardKind === 'slime')
      if (requested.length !== Math.min(1, eligible.length) ||
        requested.some((uid) => !eligible.some((card) => card.uid === uid))) {
        context.invalidSearchChoice = true
        return
      }
      const chosen = eligible.find((card) => card.uid === requested[0])
      actor.draw = shuffle(state.rng, actor.draw.filter((card) => card.uid !== chosen?.uid))
      context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      if (!chosen) return
      context.doppelgangerCopy = { ...forgetRetain(chosen), growOnPlay: effect.grow }
      context.queuedCopySource = 'Replication'
      context.queuedCopyVirtualOnly = false
      context.queuedCopyTwice = false
      context.queuedCopyForcedExhaust = false
      context.queuedCopySources = []
      note(`${actor.name} will play ${cardDef(chosen.defId).name} for 0 Energy${effect.grow ? ' and Grow it' : ''}`)
      return
    }
  }
}
