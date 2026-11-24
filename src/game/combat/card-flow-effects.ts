// Card-flow effect clauses: draw, discard, exhaust, scry, topdeck/bottomdeck,
// pile recovery, draw-pile search, card copies, play windows, and self-exhaust
// powers.
//
// Cycle-free helper module below `effects.ts`: recursive effects-layer
// mutations are supplied as callbacks.
import { combatIsOver, supportTargets } from './board.ts'
import { addDaze, forgetRetain } from './pieces.ts'
import {
  amountOf,
  cardCanBeForced,
  cardHasRetain,
  cardIsPlayable,
  copySourcesFor,
  effectiveCombatCardDef,
  invalidPlayChoice,
  latestPlayableAllyAttack,
  omniscienceEligibleCards,
} from './queries.ts'
import {
  discardPowerFromPlay,
  discardTopLine,
  metamorphosisCard,
  openCardPlayWindow,
  queuePlayerChoice,
  takeDiscardTop,
} from './slayer.ts'
import { queuedTriggers } from './trigger-queries.ts'
import { markTurnEffect } from './turn-presentation.ts'
import type { CombatState, PendingTrigger, PlayContext } from './types.ts'
import { cardCost, cardDef, cardStaysInPlay, faceOf } from '../cards.ts'
import type { Effect, TargetScope } from '../cards.ts'
import { addToDrawTop, scry } from '../piles.ts'
import { shuffle } from '../rng.ts'
import type { TriggerEvent } from '../triggers.ts'
import { CAPS } from '../types.ts'
import type { CardInstance, Player } from '../types.ts'

export interface CardFlowEffectCallbacks {
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
  drawInto: (
    state: CombatState,
    actor: Player,
    amount: number,
    pendingTriggers?: PendingTrigger[],
  ) => CardInstance[]
  discardByCardEffect: (
    state: CombatState,
    actor: Player,
    cards: readonly CardInstance[],
    context?: PlayContext,
  ) => void
  exhaustCards: (
    state: CombatState,
    actor: Player,
    cards: readonly CardInstance[],
    context?: PlayContext,
  ) => void
  fireTriggers: (
    state: CombatState,
    event: TriggerEvent,
    only?: Player,
    excludeUid?: string,
  ) => void
  scryPlayCardPlayable: (
    state: CombatState,
    playerId: string,
    revealed: readonly CardInstance[],
    cardUid: string,
    discardUids: readonly string[],
  ) => boolean
}

const CARD_FLOW_EFFECT_KIND_LIST = [
  'copyLastPlayed',
  'copyLastAllyAttack',
  'copyLastAttack',
  'draw',
  'drawThenDiscard',
  'drawToHandSize',
  'cycleHand',
  'discardNonRetain',
  'discard',
  'discardAny',
  'discardWholeHand',
  'preventDraw',
  'preventCardPlay',
  'exhaustFromHand',
  'exhaustAny',
  'exhaustHand',
  'exhaustDrawPile',
  'exhaustDrawTop',
  'exhaustNextCard',
  'exhaustSelf',
  'loseMiracleOrDiscardSelf',
  'mayExhaustSelfFor',
  'optionalPreventRoundHpLoss',
  'addDaze',
  'recoverDiscardTopCosts',
  'recoverAllDiscardCosts',
  'returnDiscardTop',
  'mayReturnDiscardTop',
  'drawOrDiscardChoice',
  'shuffleDiscardIntoDraw',
  'scry',
  'scryAndPlay',
  'scryToHand',
  'topdeck',
  'bottomdeck',
  'recoverDiscard',
  'recoverExhaust',
  'recoverExhaustToDraw',
  'recoverExhaustToDiscard',
  'searchDraw',
  'searchDrawAndPlayTwice',
  'drawAndPlayFree',
  'openPlayWindow',
] as const satisfies readonly Effect['kind'][]

export type CardFlowEffect = Extract<Effect, { kind: (typeof CARD_FLOW_EFFECT_KIND_LIST)[number] }>

const CARD_FLOW_EFFECT_KINDS: ReadonlySet<string> = new Set(CARD_FLOW_EFFECT_KIND_LIST)

export function isCardFlowEffect(effect: Effect): effect is CardFlowEffect {
  return CARD_FLOW_EFFECT_KINDS.has(effect.kind)
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

export function applyCardFlowEffect(
  state: CombatState,
  actor: Player,
  effect: CardFlowEffect,
  scope: TargetScope,
  supportScope: TargetScope,
  context: PlayContext,
  callbacks: CardFlowEffectCallbacks,
  source?: string,
): void {
  const note = (text: string) => {
    state.log = [...state.log, source ? `${source}: ${text}` : text]
  }

  switch (effect.kind) {
    case 'exhaustNextCard':
      actor.exhaustNextCardAfterUid = context.sourceCardUid
      note(`${actor.name}'s next card this turn will Exhaust`)
      return
    case 'copyLastPlayed': {
      if (context.sourceIsCopy) return
      const plays = state.playedCardsThisTurn ?? []
      const latest = [...plays].reverse().find((played, reverseIndex) => {
        if (played.copied || (reverseIndex === 0 && played.card.uid === context.sourceCardUid)) return false
        const def = effectiveCombatCardDef(
          faceOf(cardDef(played.card.defId), played.card.upgraded), actor.guardianMode,
        )
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
    case 'copyLastAttack': {
      if (context.sourceIsCopy) return
      const latest = [...(state.playedCardsThisTurn ?? [])].reverse().find((played) =>
        played.card.uid !== context.sourceCardUid && !played.copied &&
        (played.type ?? effectiveCombatCardDef(
          faceOf(cardDef(played.card.defId), played.card.upgraded), actor.guardianMode,
        ).type) === 'attack')
      if (!latest || !context.sourceCardUid) return
      const copiedDef = faceOf(cardDef(latest.card.defId), latest.card.upgraded)
      if (!cardIsPlayable(copiedDef, state, actor, actor.draw.length, false)) return
      context.doppelgangerCopy = { ...latest.card, uid: `${context.sourceCardUid}:copy` }
      context.queuedCopySource = 'Haunting Echo'
      note(`${actor.name}'s Haunting Echo copies ${copiedDef.name}`)
      return
    }
    case 'draw': {
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        // Reserve the line before drawing: a draw can reshuffle and fire
        // triggers that log, and those belong under this line, not above it.
        const at = state.log.length
        const drawnCards = callbacks.drawInto(
          state,
          target,
          amountOf(effect.amount, state, actor, undefined, context),
          context.pendingTriggers,
        )
        if (target.id === actor.id) {
          context.drawnUids = drawnCards.map((card) => card.uid)
          context.drewSkill = drawnCards.some((card) => effectiveCombatCardDef(
            faceOf(cardDef(card.defId), card.upgraded), target.guardianMode,
          ).type === 'skill')
        }
        const drawn = drawnCards.length
        if (drawn > 0) {
          const line = source ? `${source}: ${target.name} draws ${drawn}` : `${target.name} draws ${drawn}`
          state.log = [...state.log.slice(0, at), line, ...state.log.slice(at)]
          markTurnEffect(context, 'draw', target.id === actor.id ? { actor: true } : { playerId: target.id })
        }
      }
      return
    }
    case 'drawThenDiscard': {
      callbacks.applyEffect(state, actor, { kind: 'draw', amount: effect.amount }, scope, supportScope, context, source)
      if (actor.hand.length === 1) {
        callbacks.discardByCardEffect(state, actor, [actor.hand[0]!], context)
      } else if (actor.hand.length > 1) {
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
      return callbacks.applyEffect(state, actor, {
        kind: 'draw', amount: Math.max(0, effect.size - actor.hand.length),
      }, scope, supportScope, context, source)
    case 'cycleHand': {
      const moved = [...actor.hand]
      callbacks.discardByCardEffect(state, actor, moved, context)
      return callbacks.applyEffect(state, actor, { kind: 'draw', amount: moved.length },
        scope, supportScope, context, source)
    }
    case 'discardNonRetain': {
      const moved = actor.hand.filter((card) =>
        !card.retainThisTurn && !cardHasRetain(actor, card))
      callbacks.discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'preventDraw': {
      const changed = !actor.drawLocked
      actor.drawLocked = true
      note(`${actor.name} cannot draw more cards this turn`)
      if (changed) markTurnEffect(context, 'buff', { actor: true })
      return
    }
    case 'preventCardPlay': {
      actor.cardPlayLocked = true
      note(`${actor.name} cannot play additional cards this turn`)
      return
    }
    case 'openPlayWindow': {
      const offered = effect.cards === 'drawn'
        ? context.drawnUids ?? []
        : actor.hand.filter((card) => effect.cards === 'hand' || effectiveCombatCardDef(
          faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
        ).type === 'attack').map((card) => card.uid)
      openCardPlayWindow(state, actor, context, offered, effect)
      return
    }
    case 'scryAndPlay': {
      const revealed = actor.draw.slice(0, Math.max(0, effect.amount))
      const discards = context.scryDiscardUids ?? []
      const chosen = revealed.find((card) => card.uid === context.scryToHandUid)
      // "Play one of the cards" is not optional: if any reveal could be played
      // (keeping it instead of binning it), one must be named, and the named
      // one must really be playable once this Scry has finished.
      if (context.scryToHandUid !== undefined
        ? !chosen || !callbacks.scryPlayCardPlayable(state, actor.id, revealed, chosen.uid, discards)
        : revealed.some((card) => callbacks.scryPlayCardPlayable(state, actor.id, revealed, card.uid,
          discards.filter((uid) => uid !== card.uid)))) {
        context.invalidScryChoice = true
        return
      }
      if (!chosen) {
        callbacks.applyEffect(state, actor, { kind: 'scry', amount: effect.amount }, scope, supportScope, context, source)
        return
      }
      // The chosen card leaves the reveal; the rest are exactly the next cards down.
      actor.draw = actor.draw.filter((card) => card.uid !== chosen.uid)
      callbacks.applyEffect(state, actor, { kind: 'scry', amount: revealed.length - 1 }, scope, supportScope, context, source)
      if (invalidPlayChoice(context)) return
      if (revealed.length === 1) context.pendingTriggers?.push(...queuedTriggers(state, { kind: 'onScry' }, actor))
      actor.hand = [...actor.hand, forgetRetain(chosen)]
      openCardPlayWindow(state, actor, context, [chosen.uid], { cost: 0, plays: 1, optional: false })
      return
    }
    case 'bottomdeck': {
      const requested = context.topdeckUids ?? []
      const required = effect.amount === 'any' ? requested.length : Math.min(effect.amount, actor.hand.length)
      if (requested.length !== required || new Set(requested).size !== requested.length ||
        requested.some((uid) => !actor.hand.some((card) => card.uid === uid))) {
        context.invalidTopdeckChoice = true
        return
      }
      const chosen = allocate(actor, requested, required, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      const picked = new Set(chosen)
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      // In selection order, so the last card chosen ends up lowest.
      actor.draw = [...actor.draw, ...moved.map(forgetRetain)]
      // "Gain Energy equal to its cost" reads the cost printed on this board; an X
      // card and an Unplayable card (which has no cost, p.24) are worth 0.
      const gained = moved.reduce((sum, card) => {
        const face = faceOf(cardDef(card.defId), card.upgraded)
        const cost = face.unplayable ? 0 : cardCost(face, actor.powers, actor.lostHpThisCombat)
        return sum + (cost === 'X' ? 0 : cost)
      }, 0)
      if (moved.length > 0) {
        note(`${actor.name} puts ${moved.length} card${moved.length === 1 ? '' : 's'} on the bottom of their draw pile`)
      }
      const before = actor.energy
      actor.energy = Math.min(CAPS.energy, actor.energy + gained)
      if (actor.energy > before) {
        note(`${actor.name} gains ${actor.energy - before} Energy`)
        markTurnEffect(context, 'buff', { actor: true })
      }
      return
    }
    case 'discard': {
      const chosen = allocate(actor, context.discardUids, effect.amount, context)
      const moved = chosen.map((uid) => actor.hand.find((card) => card.uid === uid)!)
      callbacks.discardByCardEffect(state, actor, moved, context)
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
      callbacks.discardByCardEffect(state, actor, moved, context)
      return
    }
    case 'exhaustFromHand': {
      const chosen = allocate(actor, context.exhaustUids, effect.amount, context)
      const moved = actor.hand.filter((card) => chosen.includes(card.uid))
      context.exhaustedCardCost = moved.length === 1
        ? cardCost(faceOf(cardDef(moved[0]!.defId), moved[0]!.upgraded), actor.powers, actor.lostHpThisCombat)
        : undefined
      actor.hand = actor.hand.filter((card) => !chosen.includes(card.uid))
      context.exhaustedByCard = moved.length
      callbacks.exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
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
      callbacks.exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustHand': {
      const moved = actor.hand.filter((card) =>
        !effect.except || effectiveCombatCardDef(
          faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode,
        ).type !== effect.except)
      const picked = new Set(moved.map((card) => card.uid))
      actor.hand = actor.hand.filter((card) => !picked.has(card.uid))
      context.exhaustedByCard = moved.length
      callbacks.exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts ${moved.length}`)
      return
    }
    case 'exhaustDrawPile': {
      const moved = [...actor.draw]
      actor.draw = []
      callbacks.exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts their draw pile (${moved.length})`)
      return
    }
    case 'exhaustDrawTop': {
      const moved = actor.draw.splice(0, effect.amount)
      context.exhaustedByCard = moved.length
      callbacks.exhaustCards(state, actor, moved, context)
      if (moved.length > 0) note(`${actor.name} exhausts the top ${moved.length} cards of their draw pile`)
      return
    }
    case 'exhaustSelf': {
      const held = actor.powers.find((power) => power.uid === context.sourcePowerUid)
      if (!held) return
      actor.powers = actor.powers.filter((power) => power.uid !== held.uid)
      callbacks.exhaustCards(state, actor, [held], context)
      note(`${actor.name} exhausts ${cardDef(metamorphosisCard(held).defId).name}`)
      return
    }
    case 'loseMiracleOrDiscardSelf': {
      if (actor.miracles > 0) {
        actor.miracles -= 1
        note(`${actor.name} loses a Miracle`)
        markTurnEffect(context, 'buff', { actor: true })
        return
      }
      const held = actor.powers.find((power) => power.uid === context.sourcePowerUid)
      if (!held) return
      discardPowerFromPlay(state, actor, held, callbacks.exhaustCards)
      markTurnEffect(context, 'discard', { actor: true })
      return
    }
    case 'mayExhaustSelfFor': {
      const held = actor.powers.find((power) => power.uid === context.sourcePowerUid)
      if (!context.optionalSelfExhaust || !held) return
      actor.powers = actor.powers.filter((power) => power.uid !== held.uid)
      callbacks.exhaustCards(state, actor, [held], context)
      note(`${actor.name} exhausts ${cardDef(metamorphosisCard(held).defId).name}`)
      for (const nested of effect.effects) {
        callbacks.applyEffect(state, actor, nested, scope, supportScope, context, source)
        if (combatIsOver(state)) return
      }
      return
    }
    case 'optionalPreventRoundHpLoss': {
      actor.hpLossLimitThisRound = 0
      const held = actor.powers.find((power) => power.uid === context.sourcePowerUid)
      if (held) {
        actor.powers = actor.powers.filter((power) => power.uid !== held.uid)
        callbacks.exhaustCards(state, actor, [held], context)
      }
      return
    }
    case 'addDaze': {
      const gained = addDaze(state, actor, effect.amount, effect.pile, actor.id)
      if (gained > 0) {
        note(`${actor.name} gains ${gained} Daze`)
        markTurnEffect(context, 'buff', { actor: true })
      }
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
    case 'returnDiscardTop': {
      // "Any player's discard pile ... back to THEIR hand": the pile and the
      // destination both belong to the chosen player, never to the caster.
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        const moved = takeDiscardTop(target, effect.amount, effect.to, effect.mayRetain === true)
        if (moved.length > 0) note(discardTopLine(target, moved, effect.to))
      }
      return
    }
    case 'mayReturnDiscardTop': {
      // "You may": the owner answers privately, so the ordered Start of Turn
      // pauses on this choice instead of guessing it.
      if (actor.discard.length === 0) return
      queuePlayerChoice(state, actor, source ?? actor.name, { kind: 'returnDiscardTop', upTo: effect.upTo })
      return
    }
    case 'discardWholeHand': {
      const cards = [...actor.hand]
      if (cards.length > 0) callbacks.discardByCardEffect(state, actor, cards, context)
      return
    }
    case 'shuffleDiscardIntoDraw': {
      if (actor.draw.length + actor.discard.length === 0) return
      actor.draw = shuffle(state.rng, [...actor.draw, ...actor.discard.map(forgetRetain)])
      actor.discard = []
      actor.shuffledThisCombat = true
      note(`${actor.name} shuffles their discard pile into their draw pile`)
      if (context.pendingTriggers) context.pendingTriggers.push(...queuedTriggers(state, { kind: 'onShuffle' }, actor))
      else callbacks.fireTriggers(state, { kind: 'onShuffle' }, actor)
      return
    }
    case 'drawOrDiscardChoice': {
      const label = source ?? (context.sourceCardId
        ? faceOf(cardDef(context.sourceCardId), context.sourceCardUpgraded === true).name
        : actor.name)
      for (const target of supportTargets(state, effect, supportScope, context, actor)) {
        // Nothing to decide when the chosen player can neither draw nor discard.
        const canDraw = !target.drawLocked && target.draw.length + target.discard.length > 0
        if (!canDraw && target.hand.length === 0) continue
        queuePlayerChoice(state, target, label, { kind: 'drawOrDiscard' })
      }
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
      callbacks.discardByCardEffect(state, actor, tossed.filter((card) => !wovenCards.some((weave) => weave.uid === card.uid)), context)
      if (woven && !cardCanBeForced(faceOf(cardDef(woven.defId), woven.upgraded), state, actor, woven.attachedGemId, woven.uid)) {
        const weave = faceOf(cardDef(woven.defId), woven.upgraded)
        // Neither this Weave nor any it would have chained into can be forced
        // once it has no legal target: discard the whole scried batch rather
        // than leave a later one stranded with nowhere to queue it.
        callbacks.discardByCardEffect(state, actor, wovenCards, context)
        note(`${actor.name} cannot play ${weave.name} scried this way; it is discarded`)
      } else if (woven) {
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
            id: state.nextTriggerId++,
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
    case 'recoverExhaustToDraw': {
      const chosen = context.recoverExhaustUids ?? []
      const maximum = Math.min(effect.amount, actor.exhaust.length)
      if (chosen.length > maximum || new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.exhaust.some((card) => card.uid === uid))) {
        context.invalidRecoverChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = chosen.map((uid) => actor.exhaust.find((card) => card.uid === uid)!)
      actor.exhaust = actor.exhaust.filter((card) => !picked.has(card.uid))
      actor.draw = addToDrawTop(actor, moved).draw
      if (moved.length > 0) note(`${actor.name} returns ${moved.length} card${moved.length === 1 ? '' : 's'} from Exhaust to the draw pile`)
      return
    }
    case 'recoverExhaustToDiscard': {
      const chosen = context.recoverExhaustUids ?? []
      const required = Math.min(effect.amount, actor.exhaust.length)
      if (chosen.length !== required || new Set(chosen).size !== chosen.length ||
        chosen.some((uid) => !actor.exhaust.some((card) => card.uid === uid))) {
        context.invalidRecoverChoice = true
        return
      }
      const picked = new Set(chosen)
      const moved = chosen.map((uid) => actor.exhaust.find((card) => card.uid === uid)!)
      actor.exhaust = actor.exhaust.filter((card) => !picked.has(card.uid))
      actor.discard = [...actor.discard, ...moved.map(forgetRetain)]
      if (moved.length > 0) note(`${actor.name} returns ${moved.length} card${moved.length === 1 ? '' : 's'} from Exhaust to discard`)
      return
    }
    case 'scryToHand': {
      const revealed = actor.draw.slice(0, effect.amount)
      const recovered = context.scryToHandUid
        ? revealed.find((card) => card.uid === context.scryToHandUid &&
          effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode).type === effect.cardType)
        : undefined
      const discarded = context.scryDiscardUids ?? []
      if ((context.scryToHandUid !== undefined && !recovered) || new Set(discarded).size !== discarded.length ||
        discarded.some((uid) => !revealed.some((card) => card.uid === uid) || uid === recovered?.uid)) {
        context.invalidScryChoice = true
        return
      }
      const piles = scry({ draw: actor.draw, hand: actor.hand, discard: actor.discard }, effect.amount, discarded)
      actor.draw = recovered ? piles.draw.filter((card) => card.uid !== recovered.uid) : piles.draw
      actor.hand = recovered ? [...piles.hand, forgetRetain(recovered)] : piles.hand
      actor.discard = piles.discard
      if (recovered) note(`${actor.name} puts ${faceOf(cardDef(recovered.defId), recovered.upgraded).name} into their hand`)
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
      const chosenDef = effectiveCombatCardDef(faceOf(cardDef(chosen.defId), chosen.upgraded), actor.guardianMode)
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
      const [drawn] = callbacks.drawInto(state, actor, 1, context.pendingTriggers)
      if (!drawn) return
      markTurnEffect(context, 'draw', { actor: true })
      // Slayer Pack: A card that plays itself when drawn (Auto-Shields) already has.
      if (!actor.hand.some((card) => card.uid === drawn.uid)) return
      const drawnDef = faceOf(cardDef(drawn.defId), drawn.upgraded)
      if (!cardIsPlayable(drawnDef, state, actor) || (drawnDef.minimumX ?? 0) > 0 ||
        !cardCanBeForced(drawnDef, state, actor, drawn.attachedGemId, drawn.uid)) {
        if (effect.exhaustNonPower && !cardStaysInPlay(drawnDef)) {
          actor.hand = actor.hand.filter((card) => card.uid !== drawn.uid)
          callbacks.exhaustCards(state, actor, [drawn], context)
        } else {
          callbacks.discardByCardEffect(state, actor, [drawn], context)
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
