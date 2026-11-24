// Hermit Chamber plays, Rapid Fire counts, setup Load, and Dead or Alive rewards.
//
// Cycle-free helper module below `play.ts`: card-play/preview entry points are
// supplied as callbacks by `play.ts`.
import { clone, findPlayer } from './board.ts'
import { applyEffect, settle } from './effects.ts'
import {
  cardCanBeForced,
  cardIsPlayable,
  effectiveCombatCardDef,
  guardianGemForCard,
  reachedTimeWarpLimit,
} from './queries.ts'
import { resumeStartTurnAfterHermitSetup } from './start-turn.ts'
import type { CardChoicePreview, CombatState, PlayContext } from './types.ts'
import { cardDef, faceOf, isStarterStrikeOrDefend } from '../cards.ts'
import type { CardDef } from '../cards.ts'
import { gainStrength } from '../damage.ts'
import type { CardInstance, Player } from '../types.ts'

export type CardCopySourceName = NonNullable<CombatState['pendingCardCopy']>['sourceNames'][number]

export function hermitRapidFireCount(def: CardDef, actor: Player, sourceInHand = true): number {
  let count = def.hermit?.rapidFire ?? 0
  if (def.hermit?.rapidFireBy === 'curseInChamber') {
    count += Number(actor.chamber.some((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse'))
  } else if (def.hermit?.rapidFireBy === 'curses') {
    count += [...actor.hand, ...actor.chamber].filter((card) => faceOf(cardDef(card.defId), card.upgraded).type === 'curse').length
  } else if (def.hermit?.rapidFireBy === 'otherCardsInHand') {
    count += Math.max(0, actor.hand.length - Number(sourceInHand))
  }
  const highNoon = actor.powers.find((power) => power.defId === 'hermit_high_noon')
  if (highNoon && (isStarterStrikeOrDefend(def.id, 'Strike')
    || highNoon.upgraded && isStarterStrikeOrDefend(def.id, 'Defend'))) count++
  if (def.type === 'attack') count += actor.nextAttackRapidFire ?? 0
  if (count > 0 && actor.powers.some((power) => power.defId === 'hermit_no_holds_barred')) count++
  return count
}

export function queuedRapidFire(
  card: CardInstance,
  actor: Player,
  baseSources: CardCopySourceName[],
): Pick<NonNullable<CombatState['pendingCardCopy']>, 'sourceNames' | 'hermitRapidFireCard' | 'deferRapidFire'> {
  const printedDef = faceOf(cardDef(card.defId), card.upgraded)
  if (printedDef.guardianVariableType && actor.character !== 'guardian' && actor.guardianMode === null) {
    return { sourceNames: baseSources, deferRapidFire: true }
  }
  const def = effectiveCombatCardDef(printedDef, actor.guardianMode)
  const rapidFire = hermitRapidFireCount(def, actor, false)
  return {
    sourceNames: [
      ...baseSources,
      ...Array.from({ length: rapidFire * baseSources.length }, () => 'Rapid Fire' as const),
    ],
    hermitRapidFireCard: rapidFire > 0,
  }
}

export function stageHermitChamberCard(state: CombatState, playerId: string, cardUid: string): CombatState | null {
  const player = findPlayer(state, playerId)
  const card = player?.chamber.find((held) => held.uid === cardUid)
  if (!player || player.dead || !card || state.phase !== 'player' || state.pendingCardCopy) return null
  const pending = state.pendingHermitChamberPlays?.[0]
  if (pending && (pending.playerId !== playerId || pending.cardUids[0] !== cardUid)) return null
  const staged = clone(state)
  const actor = findPlayer(staged, playerId)!
  actor.chamber = actor.chamber.filter((held) => held.uid !== cardUid)
  actor.hand.push({ ...card, hermitDeadOn: true, ...(pending?.free ? { freeThisTurn: true } : {}) })
  if (pending) {
    const rest = pending.cardUids.slice(1)
    staged.pendingHermitChamberPlays = rest.length
      ? [{ ...pending, cardUids: rest }, ...(staged.pendingHermitChamberPlays?.slice(1) ?? [])]
      : staged.pendingHermitChamberPlays?.slice(1)
  }
  return staged
}

/** Privately previews a Chamber card whose draw is followed by a Load choice. */
export function previewHermitChamberCardChoiceWithPreview(
  state: CombatState,
  playerId: string,
  cardUid: string,
  previewCard: (state: CombatState, playerId: string, cardUid: string) => CardChoicePreview | null,
): CardChoicePreview | null {
  const staged = stageHermitChamberCard(state, playerId, cardUid)
  return staged ? previewCard(staged, playerId, cardUid) : null
}

function skipPendingHermitChamberPlay(
  state: CombatState,
  pending: NonNullable<CombatState['pendingHermitChamberPlays']>[number],
  message: string,
): CombatState {
  const next = clone(state)
  const rest = pending.cardUids.slice(1)
  next.pendingHermitChamberPlays = rest.length
    ? [{ ...pending, cardUids: rest }, ...(next.pendingHermitChamberPlays?.slice(1) ?? [])]
    : next.pendingHermitChamberPlays?.slice(1)
  next.log = [...next.log, message]
  return settle(next)
}

export function playHermitChamberCardWithPlay(
  state: CombatState,
  playerId: string,
  cardUid: string,
  context: PlayContext,
  playCardImpl: (
    state: CombatState,
    playerId: string,
    cardUid: string,
    context: PlayContext,
    previewShivTarget?: PlayContext['previewShivTarget'],
  ) => CombatState,
  previewShivTarget?: PlayContext['previewShivTarget'],
): CombatState {
  const pending = state.pendingHermitChamberPlays?.[0]
  const owner = findPlayer(state, playerId)
  // A Hermit who dies mid-resolution (e.g. a Thorns/Sharp Hide retaliation)
  // can never legally play their queued Chamber card: `stageHermitChamberCard`
  // rejects any dead player outright, so without this the mandatory play
  // (and the table-wide `phase !== 'player'`-equivalent block it imposes via
  // `mandatoryChoicePending`) would be stuck forever under Last Stand.
  if (pending && pending.playerId === playerId && owner?.dead) {
    return skipPendingHermitChamberPlay(state, pending,
      `${owner.name}'s mandatory Chamber play was skipped because they did not survive to play it`)
  }
  if (pending?.playerId === playerId && pending.cardUids[0] === cardUid && owner &&
    !owner.chamber.some((card) => card.uid === cardUid)) {
    return skipPendingHermitChamberPlay(state, pending,
      `${owner.name}'s mandatory Chamber play was skipped because the card left the Chamber`)
  }
  const staged = stageHermitChamberCard(state, playerId, cardUid)
  if (!staged) return state
  const actor = findPlayer(staged, playerId)!
  const card = actor.hand.find((held) => held.uid === cardUid)!
  const def = effectiveCombatCardDef(faceOf(cardDef(card.defId), card.upgraded), actor.guardianMode)
  if (pending && (reachedTimeWarpLimit(staged, actor) || !cardIsPlayable(def, staged, actor) ||
    !cardCanBeForced(def, staged, actor, guardianGemForCard(actor, card), card.uid))) {
    return skipPendingHermitChamberPlay(state, pending,
      `${actor.name}'s mandatory Chamber play of ${def.name} was skipped because it cannot be played`)
  }
  const resolved = playCardImpl(staged, playerId, cardUid, {
    ...context, hermitChamberPlay: true, ...(pending ? { outsidePlayWindow: true } : {}),
  }, previewShivTarget)
  return resolved === staged ? state : resolved
}

/** Assigns Dead or Alive's Strength to one living player. */
export function resolveHermitStrengthReward(state: CombatState, ownerId: string, targetPlayerId: string): CombatState {
  const pending = state.pendingHermitStrengthRewards?.[0]
  const target = state.players.find((player) => player.id === targetPlayerId && !player.dead)
  if (!pending || pending.playerId !== ownerId || !target) return state
  const next = clone(state)
  const recipient = findPlayer(next, targetPlayerId)!
  recipient.strength = gainStrength(recipient.strength, 1)
  next.pendingHermitStrengthRewards = next.pendingHermitStrengthRewards?.slice(1)
  next.log = [...next.log, `${recipient.name} gains 1 Strength from Dead or Alive`]
  return settle(next)
}

/** Resolves the Load half of the Hermit's private start-of-combat board ability. */
export function resolveHermitSetupLoad(
  state: CombatState,
  playerId: string,
  cardUid: string,
  enemyUid: string | null = null,
  prepared = false,
): CombatState {
  const pending = state.pendingHermitSetupLoads?.[0]
  const player = findPlayer(state, playerId)
  if (!pending || pending.playerId !== playerId || !player || player.dead ||
    player.chamber.length >= player.chamberSlots || !player.hand.some((card) => card.uid === cardUid)) return state
  const next = clone(state)
  const actor = findPlayer(next, playerId)!
  const context: PlayContext = { enemyUid, playerId: null, loadUids: [cardUid], loadChoiceIndex: 0,
    invalidHermitChoice: false }
  applyEffect(next, actor, { kind: 'load', amount: 1 }, 'self', 'self', context, 'Hermit board')
  if (context.invalidHermitChoice || actor.hand.some((card) => card.uid === cardUid)) return state
  next.pendingHermitSetupLoads = next.pendingHermitSetupLoads?.slice(1)
  return resumeStartTurnAfterHermitSetup(next, prepared)
}

/** Drops a disconnected Hermit's unresolved private setup choice. */
export function abandonHermitSetupLoad(state: CombatState, playerId: string, prepared = false): CombatState {
  const pending = state.pendingHermitSetupLoads?.[0]
  if (!pending || pending.playerId !== playerId) return state
  const next = clone(state)
  next.pendingHermitSetupLoads = next.pendingHermitSetupLoads?.slice(1)
  next.log = [...next.log, `${findPlayer(next, playerId)?.name ?? 'Hermit'}'s setup Load was skipped after disconnecting`]
  return resumeStartTurnAfterHermitSetup(next, prepared)
}

/** Drops a disconnected Hermit's unresolved private Chamber play. */
export function abandonHermitChamberPlay(state: CombatState, playerId: string): CombatState {
  const pending = state.pendingHermitChamberPlays?.[0]
  if (!pending || pending.playerId !== playerId) return state
  const next = clone(state)
  next.pendingHermitChamberPlays = next.pendingHermitChamberPlays?.slice(1)
  next.log = [...next.log, `${findPlayer(next, playerId)?.name ?? 'Hermit'}'s Chamber play was skipped after disconnecting`]
  return settle(next)
}
