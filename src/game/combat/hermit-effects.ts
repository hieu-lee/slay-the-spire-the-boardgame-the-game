// Downfall Hermit combat mechanics: Chamber loading, Curse load reactions,
// Dead On effects, Cheat die-relic triggers, Roulette, and Bounty attachments.
//
// Cycle-free helper module below `effects.ts`: effects-layer mutations
// (`applyEffect`, `discardByCardEffect`, `triggerChosenDieRelic`) are supplied
// as callbacks.
import { combatIsOver, resolveEnemyTargets } from './board.ts'
import { forgetRetain } from './pieces.ts'
import { queuedTriggers } from './trigger-queries.ts'
import { markTurnEffect } from './turn-presentation.ts'
import type { CombatState, PlayContext } from './types.ts'
import { cardDef, faceOf } from '../cards.ts'
import type { Effect, TargetScope } from '../cards.ts'
import { hermitCurseLoadReaction } from '../downfall/hermit.ts'
import { chosenDieRelicAbilities, relicDef } from '../relics.ts'
import type { CardInstance, Enemy, Player } from '../types.ts'

export interface HermitEffectCallbacks {
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
  discardByCardEffect: (
    state: CombatState,
    actor: Player,
    cards: readonly CardInstance[],
    context?: PlayContext,
  ) => void
  triggerChosenDieRelic: (
    state: CombatState,
    owner: Player,
    relicDefId: string,
    abilityIndex: number,
    context: Pick<PlayContext, 'enemyUid' | 'playerId' | 'pendingTriggers'>,
    sourceLabel: string,
  ) => boolean
}

const HERMIT_EFFECT_KIND_LIST = [
  'load',
  'loadSelf',
  'playChamber',
  'gainChamberSlot',
  'discardChamber',
  'discountChamber',
  'deadOnEffects',
  'deadOnHitBlock',
  'drawLastHitDamage',
  'grantNextAttackRapidFire',
  'discardHand',
  'triggerDieRelic',
  'goldenBullet',
  'roulette',
  'attachBounty',
] as const satisfies readonly Effect['kind'][]

export type HermitEffect = Extract<Effect, { kind: (typeof HERMIT_EFFECT_KIND_LIST)[number] }>

const HERMIT_EFFECT_KINDS: ReadonlySet<string> = new Set(HERMIT_EFFECT_KIND_LIST)

export function isHermitEffect(effect: Effect): effect is HermitEffect {
  return HERMIT_EFFECT_KINDS.has(effect.kind)
}

function hermitChoiceTarget(state: CombatState, context: PlayContext): Enemy | undefined {
  const index = context.hermitEnemyChoiceIndex ?? 0
  const uid = context.hermitEnemyUids?.[index] ?? context.enemyUid ?? undefined
  const target = state.enemies.find((enemy) => enemy.uid === uid && !enemy.dead)
  context.hermitEnemyChoiceIndex = index + 1
  return target
}

function resolveHermitLoadReaction(
  state: CombatState,
  actor: Player,
  loaded: CardInstance,
  context: PlayContext,
  callbacks: HermitEffectCallbacks,
): void {
  const def = faceOf(cardDef(loaded.defId), loaded.upgraded)
  if (def.type === 'curse' && loaded.defId.startsWith('hermit_')) {
    const needsTarget = ['hermit_grudge', 'hermit_malice', 'hermit_horror'].includes(loaded.defId)
    const target = needsTarget ? hermitChoiceTarget(state, context) : undefined
    if (needsTarget && !target) {
      context.invalidHermitChoice = true
      return
    }
    const reaction = hermitCurseLoadReaction(loaded.defId, loaded.upgraded,
      { weak: target?.weak ?? 0, vulnerable: target?.vulnerable ?? 0 })
    if (reaction?.kind === 'block') callbacks.applyEffect(state, actor, { kind: 'block', amount: reaction.amount }, 'self', 'self', context)
    else if (reaction?.kind === 'temporaryStrength') callbacks.applyEffect(state, actor,
      { kind: 'gainTemporaryStrength', amount: reaction.amount, loseGainedOnly: true }, 'self', 'self', context)
    else if (reaction?.kind === 'damage') callbacks.applyEffect(state, actor, { kind: 'damage', amount: reaction.amount },
      reaction.target === 'row' ? 'row' : 'enemy', 'self', { ...context, enemyUid: target!.uid, enemyRow: target!.row })
    else if (reaction?.kind === 'statuses') {
      callbacks.applyEffect(state, actor, { kind: 'applyWeak', amount: reaction.weak }, 'enemy', 'self', { ...context, enemyUid: target!.uid })
      callbacks.applyEffect(state, actor, { kind: 'applyVulnerable', amount: reaction.vulnerable }, 'enemy', 'self', { ...context, enemyUid: target!.uid })
    }
  }
  const determination = actor.powers.find((power) => power.defId === 'hermit_determination')
  if (def.type === 'curse' && determination && !state.powerTriggersUsedThisTurn.includes(`power:${determination.uid}`)) {
    state.powerTriggersUsedThisTurn.push(`power:${determination.uid}`)
    callbacks.applyEffect(state, actor, { kind: 'gainStrength', amount: 1 }, 'self', 'self', context, 'Determination')
  }
  for (const power of actor.powers.filter((held) => held.defId === 'hermit_lone_wolf')) {
    if (def.hermit?.deadOn) callbacks.applyEffect(state, actor, { kind: 'block', amount: power.upgraded ? 2 : 1 },
      'self', 'self', context, 'Lone Wolf')
  }
}

function loadHermitCards(
  state: CombatState,
  actor: Player,
  amount: number,
  upTo: boolean,
  source: 'hand' | 'discard',
  discount: boolean,
  context: PlayContext,
  callbacks: HermitEffectCallbacks,
): void {
  const zone = actor[source]
  const max = Math.min(amount, zone.length)
  const cursor = context.loadChoiceIndex ?? 0
  const remaining = context.loadUids?.slice(cursor) ?? []
  const take = upTo ? Math.min(max, remaining.length) : max
  const requested = remaining.slice(0, take)
  if ((!upTo && requested.length !== max) || new Set(requested).size !== requested.length ||
    requested.some((uid) => !zone.some((card) => card.uid === uid))) {
    context.invalidHermitChoice = true
    return
  }
  context.loadChoiceIndex = cursor + requested.length
  for (const uid of requested) {
    const replacementIndex = actor.chamber.length >= actor.chamberSlots
      ? actor.chamber.findIndex((held) => held.uid === context.chamberUids?.[context.chamberChoiceIndex ?? 0])
      : -1
    if (actor.chamber.length >= actor.chamberSlots && replacementIndex < 0) {
      context.invalidHermitChoice = true
      return
    }
    const card = actor[source].find((held) => held.uid === uid)!
    actor[source] = actor[source].filter((held) => held.uid !== uid)
    const loaded = { ...forgetRetain(card), ...(discount ? { freeThisTurn: true } : {}) }
    if (replacementIndex >= 0) {
      const [replaced] = actor.chamber.splice(replacementIndex, 1, loaded)
      actor.discard.push(forgetRetain(replaced!))
      context.chamberChoiceIndex = (context.chamberChoiceIndex ?? 0) + 1
      state.log = [...state.log, `${actor.name} discards ${cardDef(replaced!.defId).name} from the Chamber`]
    } else actor.chamber.push(loaded)
    state.log = [...state.log, `${actor.name} Loads ${cardDef(card.defId).name}`]
    resolveHermitLoadReaction(state, actor, loaded, context, callbacks)
    if (context.invalidHermitChoice || combatIsOver(state)) return
  }
}

export function applyHermitEffect(
  state: CombatState,
  actor: Player,
  effect: HermitEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  callbacks: HermitEffectCallbacks,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'load': {
      const before = [actor.hand.length, actor.draw.length, actor.discard.length, actor.chamber.length]
      loadHermitCards(state, actor, effect.amount, effect.upTo === true, effect.source ?? 'hand',
        effect.discount === true, context, callbacks)
      if ([actor.hand.length, actor.draw.length, actor.discard.length, actor.chamber.length]
        .some((value, index) => value !== before[index])) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'loadSelf':
      if (context.sourcePlayedFromChamber || context.sourceIsCopy || !context.sourceCardUid ||
        (effect.optional && context.chooseLoadSelf !== true)) return
      if (actor.chamber.length >= actor.chamberSlots) {
        const cursor = context.chamberChoiceIndex ?? 0
        const replaceUid = context.chamberUids?.[cursor]
        if (!replaceUid || !actor.chamber.some((card) => card.uid === replaceUid)) {
          context.invalidHermitChoice = true
          return
        }
        context.loadSelfReplaceUid = replaceUid
        context.chamberChoiceIndex = cursor + 1
      }
      context.loadSelf = true
      return
    case 'playChamber': {
      const cursor = context.chamberChoiceIndex ?? 0
      const available = actor.chamber.map((card) => card.uid)
      const wanted = effect.amount === 'all' ? available.length : Math.min(effect.amount, available.length)
      const selected = (context.chamberUids ?? []).slice(cursor, cursor + wanted)
      if (selected.length !== wanted || new Set(selected).size !== selected.length ||
        selected.some((uid) => !available.includes(uid))) {
        context.invalidHermitChoice = true
        return
      }
      context.chamberChoiceIndex = cursor + selected.length
      const queued = new Set((state.pendingHermitChamberPlays ?? [])
        .filter((pending) => pending.playerId === actor.id).flatMap((pending) => pending.cardUids))
      const unqueued = selected.filter((uid) => !queued.has(uid))
      if (unqueued.length > 0) state.pendingHermitChamberPlays = [
        ...(state.pendingHermitChamberPlays ?? []),
        { playerId: actor.id, sourceCardId: context.sourceCardId ?? 'hermit_eye_of_the_storm', cardUids: unqueued, free: effect.free },
      ]
      return
    }
    case 'gainChamberSlot':
      actor.chamberSlots += effect.amount
      note(`${actor.name} gains ${effect.amount} Chamber slot${effect.amount === 1 ? '' : 's'}`)
      return
    case 'discardChamber': {
      const cursor = context.chamberChoiceIndex ?? 0
      // Shadow Cloak pays with a Curse from either private zone.
      const eligible = (effect.curseOnly ? [...actor.hand, ...actor.chamber] : actor.chamber).filter((card) => !effect.curseOnly || faceOf(cardDef(card.defId), card.upgraded).type === 'curse')
      const wanted = effect.curseOnly ? effect.amount : Math.min(effect.amount, eligible.length)
      const selected = (context.chamberUids ?? []).slice(cursor, cursor + wanted)
      if (effect.optional && selected.length === 0) return
      if (selected.length !== wanted || new Set(selected).size !== selected.length ||
        selected.some((uid) => !eligible.some((card) => card.uid === uid))) {
        context.invalidHermitChoice = true
        return
      }
      context.chamberChoiceIndex = cursor + selected.length
      const cards = eligible.filter((card) => selected.includes(card.uid))
      if (effect.curseOnly) actor.hand = actor.hand.filter((card) => !selected.includes(card.uid))
      actor.chamber = actor.chamber.filter((card) => !selected.includes(card.uid))
      actor.discard.push(...cards.map(forgetRetain))
      if (cards.length) {
        note(`${actor.name} discards ${cards.map((card) => cardDef(card.defId).name).join(', ')} from ${effect.curseOnly ? 'hand or Chamber' : 'the Chamber'}`)
        markTurnEffect(context, 'discard', { actor: true })
      }
      for (const nested of cards.length > 0 ? effect.then ?? [] : []) {
        callbacks.applyEffect(state, actor, nested, scope, supportScope, context, source)
        if (combatIsOver(state) || context.invalidHermitChoice) return
      }
      return
    }
    case 'discountChamber': {
      const cursor = context.chamberChoiceIndex ?? 0
      const selected = (context.chamberUids ?? []).slice(cursor, cursor + effect.amount)
      if (selected.length !== Math.min(effect.amount, actor.chamber.length) || new Set(selected).size !== selected.length ||
        selected.some((uid) => !actor.chamber.some((card) => card.uid === uid))) {
        context.invalidHermitChoice = true
        return
      }
      context.chamberChoiceIndex = cursor + selected.length
      const changed = actor.chamber.some((card) => selected.includes(card.uid) && !card.freeThisTurn)
      actor.chamber = actor.chamber.map((card) => selected.includes(card.uid) ? { ...card, freeThisTurn: true } : card)
      if (changed) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'deadOnEffects':
      if (!context.sourceHermitDeadOn) return
      for (const nested of effect.effects) {
        callbacks.applyEffect(state, actor, nested, scope, supportScope, context, source)
        if (combatIsOver(state) || context.invalidHermitChoice) return
      }
      if (!context.hermitDeadOnTriggered) {
        context.hermitDeadOnTriggered = true
        state.pendingTriggers = [
          ...(state.pendingTriggers ?? []), ...queuedTriggers(state, { kind: 'onHermitDeadOn' }, actor),
        ]
      }
      return
    case 'deadOnHitBlock':
      if (!context.lastHitDamageBeforeBlock) return
      return callbacks.applyEffect(state, actor, { kind: 'block', amount: context.lastHitDamageBeforeBlock }, 'self', supportScope, context, source)
    case 'drawLastHitDamage':
      return callbacks.applyEffect(state, actor, { kind: 'draw', amount: context.lastHitDamage ?? 0 }, 'self', supportScope, context, source)
    case 'grantNextAttackRapidFire':
      actor.nextAttackRapidFire = (actor.nextAttackRapidFire ?? 0) + 1
      return
    case 'discardHand': {
      const cards = [...actor.hand]
      if (cards.length) callbacks.discardByCardEffect(state, actor, cards)
      return
    }
    case 'triggerDieRelic': {
      const cursor = context.hermitDieRelicChoiceIndex ?? 0
      const choices = context.hermitDieRelics?.slice(cursor) ?? []
      if (choices.length > effect.amount || (!effect.upTo && choices.length !== effect.amount) ||
        new Set(choices.map((choice) => `${choice.playerId}:${choice.relicIndex}`)).size !== choices.length) {
        context.invalidHermitChoice = true
        return
      }
      for (const choice of choices) {
        const owner = choice && state.players.find((candidate) => candidate.id === choice.playerId && !candidate.dead)
        const held = owner?.relics[choice?.relicIndex ?? -1]
        const ability = held && chosenDieRelicAbilities(relicDef(held.defId))[choice?.abilityIndex ?? -1]
        if (!choice || !owner || !held || !ability || ability.trigger.kind !== 'dieRelic' ||
          !callbacks.triggerChosenDieRelic(state, owner, held.defId, choice.abilityIndex, {
            enemyUid: choice.enemyUid ?? null,
            playerId: choice.targetPlayerId ?? owner.id,
            pendingTriggers: context.pendingTriggers,
          }, `${actor.name}'s Cheat (${relicDef(held.defId).name})`)) {
          context.invalidHermitChoice = true
          return
        }
        context.hermitDieRelicChoiceIndex = (context.hermitDieRelicChoiceIndex ?? 0) + 1
        if (combatIsOver(state)) return
      }
      return
    }
    case 'goldenBullet': {
      const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0]
      if (!target) return
      const deadOn = context.sourceHermitDeadOn && target.vulnerable > 0
      callbacks.applyEffect(state, actor, { kind: 'hit', amount: effect.amount }, 'enemy', supportScope, context, source)
      if (deadOn && !combatIsOver(state)) {
        callbacks.applyEffect(state, actor, { kind: 'deadOnEffects', effects: [] }, 'enemy', supportScope, context, source)
      }
      return
    }
    case 'roulette':
      for (const nested of effect.byRoll[state.die] ?? []) {
        callbacks.applyEffect(state, actor, nested, nested.kind === 'rowHit' ? 'row' : scope, supportScope, context, source)
        if (combatIsOver(state)) return
      }
      return
    case 'attachBounty': {
      const target = resolveEnemyTargets(state, 'enemy', context.enemyUid)[0]
      if (!target) return
      callbacks.applyEffect(state, actor, { kind: 'applyVulnerable', amount: effect.vulnerable }, 'enemy', supportScope, context, source)
      if (context.sourceIsCopy || !context.sourceCardUid) return
      target.hermitBounties = [...(target.hermitBounties ?? []), {
        card: { uid: context.sourceCardUid, defId: context.sourceCardId!, upgraded: context.sourceCardUpgraded === true },
        playerId: actor.id,
      }]
      context.sourceAttached = true
      return
    }
  }
}
