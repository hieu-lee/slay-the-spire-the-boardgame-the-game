import type React from 'react'
import { cardDef, faceOf } from '../game/cards.ts'
import type { CardDef } from '../game/cards.ts'
import type { Amount, Condition, CountOf, Effect } from '../game/cards.ts'
import type { HandEndOfTurnEffect } from '../game/cards.ts'
import { cardImagePath } from '../game/assets.ts'
import { Icon } from './Icon.tsx'
import type { CardInstance } from '../game/types.ts'
import type { Trigger } from '../game/triggers.ts'

type CardProps = {
  card: CardInstance
  playable?: boolean
  /** Staged for play, waiting on a target or a choice. */
  selected?: boolean
  /** Chosen as the subject of another card's discard or exhaust effect. */
  picked?: boolean
  /** Position in the fan, -1 (leftmost) to 1 (rightmost), 0 in the middle. */
  fan?: number
  onClick?: (card: CardInstance) => void
}

/**
 * What a screen reader announces for the card.
 *
 * The face is a scan, so the printed numbers are an IMAGE and are never read
 * out. This string carries the clauses that change HOW the card is played —
 * its effects, reach, and whether playing it spends the card for good.
 */
const COUNT_LABEL: Record<CountOf, string> = {
  orbs: 'charged orb',
  orbTypes: 'different orb type',
  block: 'Block',
  strength: 'Strength',
  cardsInHand: 'other card in hand',
}

function conditionText(condition: Condition): string {
  switch (condition.kind) {
    case 'hasShiv': return 'you have a Shiv'
    case 'targetPoisoned': return 'the target has Poison'
    case 'discardTopCosts': return `your discard top costs ${condition.cost}`
    case 'dieShows': return `the die shows ${condition.faces.join(' or ')}`
    case 'inStance': return `you are in ${condition.stance}`
    case 'discardedThisTurn': return 'you discarded this turn'
    case 'stanceChangedThisTurn': return 'you changed stance this turn'
    case 'targetFullHp': return 'the target is at full hit points'
    case 'firstTurnOfCombat': return 'it is the first turn of combat'
    case 'hasNoAttacksInHand': return 'you have no Attacks in hand'
    case 'goldAtLeast': return `you have ${condition.amount} or more gold`
    case 'orbsAtLeast': return `you have ${condition.amount} or more Orbs`
  }
}

function amountText(amount: Amount, hit = false): string {
  if (typeof amount === 'number') return String(amount)
  const parts: string[] = []
  if (amount.base || (!amount.bonus && !amount.per)) parts.push(String(amount.base))
  if (amount.bonus) parts.push(`${amount.bonus.plus} if ${conditionText(amount.bonus.when)}`)
  if (amount.per) {
    // Hit arithmetic already adds Strength once. A hit's counted Strength is
    // therefore the printed total multiplier, not only the stored extra scale.
    const scale = (amount.scale ?? 1) + (hit && amount.per === 'strength' ? 1 : 0)
    parts.push(`${scale} per ${COUNT_LABEL[amount.per]}`)
  }
  return parts.join(' plus ')
}

function effectText(effect: Effect): string {
  const condition = effect.when ? ` if ${conditionText(effect.when)}` : ''
  switch (effect.kind) {
    case 'hit': return `deal ${amountText(effect.amount, true)} damage${effect.times ? ` ${amountText(effect.times)} times` : ''}${condition}`
    case 'damage': return `deal ${effect.amount} damage${condition}`
    case 'loseHp': return `lose ${effect.amount} hit points${condition}`
    case 'loseOwnHp': return `lose ${effect.amount} hit points${condition}`
    case 'block': return `gain ${amountText(effect.amount)} Block${condition}`
    case 'applyVulnerable': return `apply ${effect.amount} Vulnerable${condition}`
    case 'applyWeak': return `apply ${effect.amount} Weak${condition}`
    case 'gainStrength': return `gain ${effect.amount} Strength${condition}`
    case 'gainTemporaryStrength': return effect.loseGainedOnly
      ? `gain ${effect.amount} Strength, lose that Strength at end of turn${condition}`
      : `gain ${effect.amount} Strength, lose ${effect.amount} Strength at end of turn${condition}`
    case 'poison': return `apply ${effect.amount} Poison${condition}`
    case 'draw': return `draw ${amountText(effect.amount)} cards${condition}`
    case 'preventDraw': return 'cannot draw more cards this turn'
    case 'switchRows': return 'may switch rows with another player'
    case 'gainEnergy': return `gain ${effect.amount} Energy${condition}`
    case 'gainShiv': return `gain ${effect.amount} Shivs${condition}`
    case 'gainMiracle': return `gain ${effect.amount} Miracles${condition}`
    case 'enterStance': return `enter ${effect.stance}${condition}`
    case 'channel': return `channel ${effect.amount} ${effect.orb} orbs${condition}`
    case 'evoke': return `evoke ${effect.times} orbs${condition}`
    case 'channelDieOrb': return `channel Lightning on die 1 or 2, Frost on 3 or 4, Dark on 5 or 6${condition}`
    case 'recurseOrb': return `evoke an Orb, then channel that Orb${condition}`
    case 'scry': return `scry ${effect.amount}${condition}`
    case 'addDaze': return `put ${effect.amount} Daze on your ${effect.pile} pile${condition}`
    case 'recoverDiscardTopCosts': return `return a ${effect.cost}-cost discard top to hand${condition}`
    case 'heal': return `heal ${effect.amount}${condition}`
    case 'clearDebuffs': return `remove all Weak and Vulnerable${condition}`
    case 'clearTargetBlock': return `remove all Block from the target${condition}`
    case 'removeAllOrbs': return `remove all of your Orbs${condition}`
    case 'gainEnergyIfTargetDead': return `gain ${effect.amount} energy if the target dies${condition}`
    case 'discard': return `discard ${effect.amount} cards${condition}`
    case 'exhaustFromHand': return `exhaust ${effect.amount} cards from hand${condition}`
  }
}

function triggerText(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'startOfCombat': return 'at the start of combat'
    case 'startOfTurn': return 'at the start of your turn'
    case 'endOfTurn': return 'at the end of your turn'
    case 'endOfCombat': return 'at the end of combat'
    case 'dieRelic': return `when the die shows ${trigger.faces.join(' or ')}`
    case 'onPlayCard': return trigger.cardType
      ? `after you play a ${trigger.cardType} card`
      : 'after you play a card'
    case 'onExhaust': return 'whenever you exhaust a card'
    case 'onDraw': return 'whenever you draw a card'
    case 'onEnterStance': return trigger.stance
      ? `whenever you enter ${trigger.stance}`
      : 'whenever you enter a stance'
    case 'onScry': return 'whenever you scry'
    case 'onGainBlock': return 'whenever you gain Block'
    case 'onShuffle': return 'whenever you shuffle your discard pile'
  }
}

function handEndOfTurnText(effect: HandEndOfTurnEffect): string {
  const when = 'handSizeAtMost' in effect && effect.handSizeAtMost !== undefined
    ? ` if you have ${effect.handSizeAtMost} or fewer cards in hand`
    : ''
  switch (effect.kind) {
    case 'damage': return `at end of turn, take ${effect.amount} damage${when}`
    case 'loseHp': return `at end of turn, lose ${effect.amount} hit points${when}`
    case 'gainWeak': return `at end of turn, gain ${effect.amount} Weak${when}`
    case 'loseBlock': return `at end of turn, lose ${effect.amount} Block${when}`
  }
}

function accessibleName(def: CardDef): string {
  return [
    def.name,
    // "cost —" reads as a dangling "cost" once a screen reader drops the dash
    // at its default punctuation setting. An unplayable card and one you merely
    // cannot afford are both greyed out, so the name is the only thing that can
    // tell them apart.
    def.unplayable ? 'unplayable' : `cost ${costLabel(def)}`,
    def.type,
    // A row always takes the boss too, wherever the boss stands (p.15). Saying
    // only "a whole row" tells a player picking a distant row that the boss is
    // safe from it, which is the opposite of the rule.
    def.target === 'row' ? 'hits a whole row and any boss' : '',
    def.target === 'allEnemies' ? 'hits every enemy' : '',
    def.supportTarget === 'anyPlayer' ? 'support effect may target any player' : '',
    def.supportTarget === 'allPlayers' ? 'support effect applies to all players' : '',
    def.trigger ? triggerText(def.trigger) : '',
    ...(def.modes
      ? def.modes.map((mode) => `choose ${mode.effects.map(effectText).join(' and ')}`)
      : def.effects.map(effectText)),
    ...(def.handEndOfTurn ?? []).map(handEndOfTurnText),
    def.toDrawTop ? 'returns to the top of your draw pile when played' : '',
    def.retain ? 'retain' : '',
    def.exhaust ? 'exhausts when played' : '',
    def.ethereal ? 'ethereal, exhausts at end of turn if still in hand' : '',
  ]
    .filter(Boolean)
    .join(', ')
}

/** The energy cost badge, or nothing at all for an unplayable card (p.24). */
function costLabel(def: CardDef): string {
  if (def.unplayable) return '—'
  return def.cost === 'X' ? 'X' : String(def.cost)
}

export function Card({
  card,
  playable = true,
  selected = false,
  picked = false,
  fan = 0,
  onClick,
}: CardProps) {
  const def = faceOf(cardDef(card.defId), card.upgraded)
  const className = [
    'card',
    playable ? '' : 'card--unplayable',
    selected ? 'card--selected' : '',
    picked ? 'card--picked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={className}
      style={{
        // Tilt with distance from the middle, and drop the outer cards a
        // little so the row reads as an arc rather than a shelf.
        // The spread grows with the hand: a fixed angle made five cards look
        // merely crooked and only became a fan at eight or more.
        '--fan-angle': `${fan * 11}deg`,
        '--fan-lift': `${Math.abs(fan) * 14}px`,
      } as React.CSSProperties}
      disabled={!playable}
      onClick={() => onClick?.(card)}
      aria-label={accessibleName(def)}
      aria-pressed={selected || picked}
      title={def.name}
    >
      <img
        className="card__art"
        src={cardImagePath(def, card.upgraded)}
        alt=""
        loading="lazy"
        onError={(event) => {
          // Not every card has a scan in the source set (Daze, for one). Fall
          // back to the card frame rather than showing a broken image.
          event.currentTarget.style.visibility = 'hidden'
        }}
      />
      <span className="card__fallback" aria-hidden="true">
        {def.name}
      </span>
      {def.target === 'row' ? (
        // The burst printed on Cleave and its like. Marked hidden because
        // `accessibleName` already says "hits a whole row" — announced here as
        // well, every such card would read its reach out twice.
        <span className="card__aoe" aria-hidden="true">
          <Icon name="aoe" size={18} />
        </span>
      ) : null}
      <span className="card__cost" aria-hidden="true">
        {costLabel(def)}
      </span>
    </button>
  )
}
