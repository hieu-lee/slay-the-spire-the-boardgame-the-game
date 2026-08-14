// When an ongoing effect fires.
//
// Relics and Powers are the same idea wearing different hats: a permanent thing
// in front of you that reacts to the game. They share this vocabulary so one
// dispatcher can serve both, which is why the relic triggers moved here rather
// than a parallel set being invented for Powers.
//
// Several kinds have no card using them YET. They are not speculative: a survey
// of the 236 cards already transcribed from scans counted 24 end-of-turn,
// 17 start-of-turn, 6 exhaust, 4 draw, 2 scry, 2 stance-change, 2 gain-block
// and 1 shuffle Power, plus several that narrow on the type of card played.
// The list is the measured requirement, not a guess.
import type { CardType, Stance } from './types.ts'

export type Trigger =
  /** Turn 1 only (p.12). */
  | { kind: 'startOfCombat' }
  /** Start of Turn, after Reset but before the shared Draw step. */
  | { kind: 'beforeDraw' }
  | { kind: 'startOfTurn' }
  | { kind: 'endOfTurn' }
  | { kind: 'endOfCombat' }
  /** Fires during Start of Turn when the shared die shows a matching face (p.19). */
  | { kind: 'dieRelic'; faces: number[] }
  /** After a card finishes resolving. `cardType` narrows it to attacks, skills, etc. */
  | { kind: 'onPlayCard'; cardType?: CardType }
  /** Once when one card effect makes this player discard one or more cards. */
  | { kind: 'onDiscard' }
  | { kind: 'onExhaust' }
  | { kind: 'onDraw'; cardType?: CardType; cardTypes?: CardType[] }
  | { kind: 'onEnterStance'; stance?: Stance }
  | { kind: 'onScry' }
  | { kind: 'onGainBlock' }
  /** Fires when this player actually adds one or more Poison cubes to an enemy. */
  | { kind: 'onApplyPoison' }
  /** Fires once per Weak, Vulnerable, or Poison token this player actually puts on an enemy. */
  | { kind: 'onPutEnemyToken' }
  | { kind: 'onShuffle' }

/** What actually happened, so a trigger can decide whether it applies. */
export type TriggerEvent = {
  kind: Trigger['kind']
  /** The die showing this round, for `dieRelic`. */
  die?: number
  /** The type of the card that was just played, for `onPlayCard`. */
  cardType?: CardType
  /** The stance just entered, for `onEnterStance`. */
  stance?: Stance
  /** Enemy that received a token, for `onPutEnemyToken`. */
  enemyUid?: string
}

/** Whether a trigger fires for an event. */
export function triggerMatches(trigger: Trigger, event: TriggerEvent): boolean {
  if (trigger.kind !== event.kind) return false

  if (trigger.kind === 'dieRelic') {
    return event.die !== undefined && trigger.faces.includes(event.die)
  }
  if (trigger.kind === 'onPlayCard') {
    // No cardType on the trigger means "any card".
    return trigger.cardType === undefined || trigger.cardType === event.cardType
  }
  if (trigger.kind === 'onDraw') {
    return (trigger.cardType === undefined && trigger.cardTypes === undefined) ||
      trigger.cardType === event.cardType ||
      (event.cardType !== undefined && trigger.cardTypes?.includes(event.cardType) === true)
  }
  if (trigger.kind === 'onEnterStance') {
    return trigger.stance === undefined || trigger.stance === event.stance
  }
  return true
}
